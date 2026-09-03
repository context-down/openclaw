import { initialState, Task, TaskStatus } from "@lit/task";
import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayConnectionScope } from "../../lib/gateway-connection-lifecycle.ts";
import type {
  PluginDiscoveryCategoriesResult,
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";
import type { PluginDiscoveryIntent } from "./catalog-results.ts";
import type { PluginCardAttribution } from "./plugin-card.ts";

type PluginDiscoveryGateway = {
  getClient: () => GatewayBrowserClient | null;
  isConnected: () => boolean;
  capture: () => GatewayConnectionScope | null;
  isCurrent: (scope: GatewayConnectionScope) => boolean;
};

export class PluginDiscoveryController {
  result: PluginDiscoveryResult | null = null;
  error: string | null = null;
  categories: PluginDiscoveryCategory[] = [];
  categoriesError: string | null = null;
  featured: PluginDiscoveryEntry[] = [];
  featuredError: string | null = null;
  intent: PluginDiscoveryIntent = "all";
  category: string | null = null;
  query = "";
  loadingMore = false;

  private committedQuery = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private observer: IntersectionObserver | null = null;
  private readonly entriesById = new Map<string, PluginDiscoveryEntry>();
  private readonly browseTask: Task;
  private readonly categoriesTask: Task;
  private readonly featuredTask: Task;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly gateway: PluginDiscoveryGateway,
  ) {
    this.browseTask = new Task(host, {
      autoRun: false,
      args: () =>
        [
          this.gateway.isConnected() ? this.gateway.getClient() : null,
          this.intent,
          this.category,
          this.committedQuery,
        ] as const,
      task: ([client, intent, category, query], { signal }) =>
        client
          ? client.request<PluginDiscoveryResult>(
              "plugins.catalog.browse",
              {
                intent,
                ...(category ? { category } : {}),
                ...(query ? { query } : {}),
                pageSize: 20,
              },
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.result = result;
        this.rememberEntries(result.items);
      },
      onError: (error) => {
        this.error = formatUiError(error);
      },
    });
    this.categoriesTask = new Task(host, {
      autoRun: false,
      args: () => [this.gateway.isConnected() ? this.gateway.getClient() : null] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<PluginDiscoveryCategoriesResult>(
              "plugins.catalog.categories",
              {},
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.categories = result.categories;
      },
      onError: (error) => {
        this.categoriesError = formatUiError(error);
      },
    });
    this.featuredTask = new Task(host, {
      autoRun: false,
      args: () => [this.gateway.isConnected() ? this.gateway.getClient() : null] as const,
      task: ([client], { signal }) =>
        client
          ? client.request<PluginDiscoveryResult>(
              "plugins.catalog.browse",
              { intent: "trending", pageSize: 6 },
              { signal },
            )
          : initialState,
      onComplete: (result) => {
        this.featured = result.items.filter((plugin) => !plugin.local.enabled).slice(0, 3);
        this.rememberEntries(result.items);
      },
      onError: (error) => {
        this.featuredError = formatUiError(error);
      },
    });
  }

  get loading(): boolean {
    return this.gateway.isConnected() && this.browseTask.status === TaskStatus.PENDING;
  }

  get featuredLoading(): boolean {
    return this.gateway.isConnected() && this.featuredTask.status === TaskStatus.PENDING;
  }

  get attributions(): ReadonlyMap<string, PluginCardAttribution> {
    const attributions = new Map<string, PluginCardAttribution>();
    for (const entry of this.entriesById.values()) {
      if (!entry.local.pluginId) {
        continue;
      }
      attributions.set(entry.local.pluginId, {
        ...(entry.catalog.author ? { author: entry.catalog.author } : {}),
        official: entry.catalog.official,
      });
    }
    return attributions;
  }

  private rememberEntries(entries: readonly PluginDiscoveryEntry[]): void {
    for (const entry of entries) {
      this.entriesById.set(entry.id, entry);
    }
  }

  ensureInitial(): void {
    if (!this.gateway.isConnected() || !this.gateway.getClient()) {
      return;
    }
    if (this.browseTask.status === TaskStatus.INITIAL && !this.result && !this.error) {
      void this.refresh();
    }
    if (
      this.categoriesTask.status === TaskStatus.INITIAL &&
      this.categories.length === 0 &&
      !this.categoriesError
    ) {
      void this.refreshCategories();
    }
    if (
      this.featuredTask.status === TaskStatus.INITIAL &&
      this.featured.length === 0 &&
      !this.featuredError
    ) {
      void this.refreshFeatured();
    }
  }

  invalidate(): void {
    void this.browseTask.run([null, this.intent, this.category, this.committedQuery]);
    void this.categoriesTask.run([null]);
    void this.featuredTask.run([null]);
    this.result = null;
    this.error = null;
    this.categories = [];
    this.categoriesError = null;
    this.featured = [];
    this.featuredError = null;
    this.entriesById.clear();
    this.loadingMore = false;
  }

  disconnect(): void {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
  }

  async refresh(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.error = null;
    this.loadingMore = false;
    await this.browseTask.run([client, this.intent, this.category, this.committedQuery]);
  }

  async refreshCategories(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.categoriesError = null;
    await this.categoriesTask.run([client]);
  }

  async refreshFeatured(): Promise<void> {
    const client = this.gateway.getClient();
    if (!client || !this.gateway.isConnected()) {
      return;
    }
    this.featuredError = null;
    await this.featuredTask.run([client]);
  }

  selectIntent(intent: PluginDiscoveryIntent): void {
    this.intent = intent;
    void this.refresh();
  }

  selectCategory(category: string | null): void {
    this.category = category;
    void this.refresh();
  }

  updateQuery(query: string): void {
    this.query = query;
    this.host.requestUpdate();
    if (this.searchTimer) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.committedQuery = query.trim();
      void this.refresh();
    }, 250);
  }

  observeLoadMore(element: Element | undefined): void {
    this.observer?.disconnect();
    this.observer = null;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void this.loadMore();
        }
      },
      { rootMargin: "240px 0px" },
    );
    this.observer.observe(element);
  }

  async loadMore(): Promise<void> {
    const cursor = this.result?.nextCursor;
    const scope = this.gateway.capture();
    if (!cursor || !scope || this.loadingMore || this.committedQuery) {
      return;
    }
    this.loadingMore = true;
    this.error = null;
    this.host.requestUpdate();
    try {
      const next = await scope.client.request<PluginDiscoveryResult>("plugins.catalog.browse", {
        intent: this.intent,
        ...(this.category ? { category: this.category } : {}),
        cursor,
        pageSize: 20,
      });
      if (!this.gateway.isCurrent(scope) || cursor !== this.result?.nextCursor) {
        return;
      }
      const seen = new Set(this.result.items.map((plugin) => plugin.id));
      this.result = {
        items: [...this.result.items, ...next.items.filter((plugin) => !seen.has(plugin.id))],
        ...(next.nextCursor ? { nextCursor: next.nextCursor } : {}),
      };
      this.rememberEntries(next.items);
    } catch (error) {
      if (this.gateway.isCurrent(scope)) {
        this.error = formatUiError(error);
      }
    } finally {
      if (this.gateway.isCurrent(scope)) {
        this.loadingMore = false;
        this.host.requestUpdate();
      }
    }
  }
}

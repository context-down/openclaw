import { html, nothing, type TemplateResult } from "lit";
import { ref } from "lit/directives/ref.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { renderSettingsLoadingSkeleton, renderSettingsPage } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginDiscoveryCategory,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";

export type PluginDiscoveryIntent = "all" | "trending" | "official";

export type PluginCatalogResultsProps = {
  connected: boolean;
  loading: boolean;
  loadingMore: boolean;
  result: PluginDiscoveryResult | null;
  error: string | null;
  categories: readonly PluginDiscoveryCategory[];
  categoriesError: string | null;
  featured: readonly PluginDiscoveryEntry[];
  featuredLoading: boolean;
  featuredError: string | null;
  intent: PluginDiscoveryIntent;
  category: string | null;
  query: string;
  entryHref: (id: string) => string;
  categorySettingsHref: (slug: string) => string | null;
  onIntentChange: (intent: PluginDiscoveryIntent) => void;
  onCategoryChange: (category: string | null) => void;
  onQueryChange: (query: string) => void;
  onOpenEntry: (id: string) => void;
  onOpenCategorySettings: (slug: string) => void;
  onLoadMoreTarget: (element: Element | undefined) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onRetryCategories: () => void;
  onRetryFeatured: () => void;
};

const PINNED_CATEGORY_ORDER = new Map([
  ["channels", 0],
  ["models", 1],
  ["memory", 2],
  ["context", 3],
]);

const CATEGORY_ICONS: Readonly<Record<string, TemplateResult>> = {
  activity: icons.activity,
  "book-open": icons.book,
  brain: icons.brain,
  database: icons.box,
  "git-branch": icons.gitPullRequest,
  globe: icons.globe,
  "message-circle": icons.messageSquare,
  "message-square": icons.messageSquare,
  package: icons.box,
  palette: icons.wandSparkles,
  shield: icons.shield,
  wrench: icons.settings,
};

function prioritizePluginCategories(
  categories: readonly PluginDiscoveryCategory[],
): PluginDiscoveryCategory[] {
  return categories.toSorted((left, right) => {
    const leftPinned = PINNED_CATEGORY_ORDER.get(left.slug);
    const rightPinned = PINNED_CATEGORY_ORDER.get(right.slug);
    if (leftPinned !== undefined || rightPinned !== undefined) {
      return (leftPinned ?? Number.MAX_SAFE_INTEGER) - (rightPinned ?? Number.MAX_SAFE_INTEGER);
    }
    return left.order - right.order;
  });
}

function categoryIcon(icon: string | undefined): TemplateResult {
  return (icon && CATEGORY_ICONS[icon]) || icons.box;
}

function formatCount(value: number | undefined): string | null {
  return value === undefined ? null : new Intl.NumberFormat().format(value);
}

function stateLabel(plugin: PluginDiscoveryEntry): string {
  if (plugin.local.enabled) {
    return t("pluginsPage.enabled");
  }
  if (plugin.local.installed) {
    return t("pluginsPage.installedDisabled");
  }
  return t("pluginsPage.available");
}

function entryMeta(plugin: PluginDiscoveryEntry): TemplateResult {
  const downloads = formatCount(plugin.catalog.downloads);
  const installs = formatCount(plugin.catalog.installs);
  return html`<div class="plugin-catalog-result__meta">
    ${plugin.catalog.author ? html`<span>@${plugin.catalog.author}</span>` : nothing}
    ${plugin.catalog.official ? html`<span>${t("pluginsPage.official")}</span>` : nothing}
    ${plugin.catalog.verificationTier
      ? html`<span>${plugin.catalog.verificationTier}</span>`
      : nothing}
    ${installs ? html`<span>${t("pluginsPage.installCount", { count: installs })}</span>` : nothing}
    ${downloads
      ? html`<span>${t("pluginsPage.downloadCount", { count: downloads })}</span>`
      : nothing}
  </div>`;
}

function renderFeaturedCard(
  plugin: PluginDiscoveryEntry,
  props: PluginCatalogResultsProps,
): TemplateResult {
  return html`<a
    class="plugin-featured-card oc-card oc-card-interactive"
    href=${props.entryHref(plugin.id)}
    data-plugin-id=${plugin.id}
    @click=${(event: MouseEvent) => {
      if (!shouldHandleNavigationClick(event)) {
        return;
      }
      event.preventDefault();
      props.onOpenEntry(plugin.id);
    }}
  >
    <div class="installed-plugins-card__head">
      <span class="installed-plugins-card__art plugin-featured-card__art" aria-hidden="true">
        ${categoryIcon(plugin.catalog.icon)}
      </span>
      <div class="installed-plugins-card__identity">
        <h3>${plugin.catalog.name}</h3>
        <p>${plugin.catalog.summary || t("pluginsPage.optionalCapability")}</p>
      </div>
    </div>
    ${entryMeta(plugin)}
  </a>`;
}

function renderFeatured(props: PluginCatalogResultsProps): TemplateResult {
  return renderSettingsPage(
    html`<section class="plugin-featured" aria-labelledby="plugin-featured-title">
      <header class="plugin-catalog-results__header">
        <div>
          <h2 id="plugin-featured-title">${t("pluginsPage.featuredTitle")}</h2>
          <p>${t("pluginsPage.featuredDescription")}</p>
        </div>
      </header>
      ${props.featuredLoading
        ? renderSettingsLoadingSkeleton({
            label: t("pluginsPage.loadingFeatured"),
            rows: 3,
            carapace: true,
          })
        : props.featuredError
          ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
              <span>${formatUiExternalText(props.featuredError)}</span>
              <button
                type="button"
                class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
                @click=${props.onRetryFeatured}
              >
                ${t("pluginsPage.tryAgain")}
              </button>
            </div>`
          : props.featured.length === 0
            ? html`<p class="plugin-catalog-results__empty">
                ${t("pluginsPage.noFeaturedResults")}
              </p>`
            : html`<div class="plugin-featured__grid">
                ${repeat(
                  props.featured,
                  (plugin) => plugin.id,
                  (plugin) => renderFeaturedCard(plugin, props),
                )}
              </div>`}
    </section>`,
    { wide: true, carapace: true },
  );
}

function renderCategories(props: PluginCatalogResultsProps): TemplateResult {
  if (props.categoriesError) {
    return html`<div class="plugin-catalog-categories__error" role="alert">
      <span>${formatUiExternalText(props.categoriesError)}</span>
      <button
        type="button"
        class="btn btn--xs oc-action oc-action-ghost"
        @click=${props.onRetryCategories}
      >
        ${t("pluginsPage.tryAgain")}
      </button>
    </div>`;
  }
  return html`<div class="plugin-catalog-categories" aria-label=${t("pluginsPage.categoriesLabel")}>
    <button
      type="button"
      class="plugin-catalog-category ${props.category === null ? "is-active" : ""}"
      aria-pressed=${props.category === null}
      @click=${() => props.onCategoryChange(null)}
    >
      <span aria-hidden="true">${icons.layoutGrid}</span>
      <span>${t("pluginsPage.allCategories")}</span>
    </button>
    ${repeat(
      prioritizePluginCategories(props.categories),
      (item) => item.slug,
      (item) => {
        const settingsHref = props.categorySettingsHref(item.slug);
        return html`<div class="plugin-catalog-category-wrap">
          <button
            type="button"
            class="plugin-catalog-category ${props.category === item.slug ? "is-active" : ""}"
            title=${item.description}
            aria-pressed=${props.category === item.slug}
            @click=${() => props.onCategoryChange(item.slug)}
          >
            <span aria-hidden="true">${categoryIcon(item.icon)}</span>
            <span>${item.label}</span>
          </button>
          ${settingsHref
            ? html`<a
                class="plugin-catalog-category__settings"
                href=${settingsHref}
                aria-label=${t("pluginsPage.configureCategory", { category: item.label })}
                @click=${(event: MouseEvent) => {
                  if (!shouldHandleNavigationClick(event)) {
                    return;
                  }
                  event.preventDefault();
                  props.onOpenCategorySettings(item.slug);
                }}
                >${icons.settings}</a
              >`
            : nothing}
        </div>`;
      },
    )}
  </div>`;
}

function renderResultRow(
  plugin: PluginDiscoveryEntry,
  props: PluginCatalogResultsProps,
): TemplateResult {
  const firstCategory = plugin.catalog.categories[0];
  return html`<a
    class="plugin-catalog-result"
    href=${props.entryHref(plugin.id)}
    data-plugin-id=${plugin.id}
    @click=${(event: MouseEvent) => {
      if (!shouldHandleNavigationClick(event)) {
        return;
      }
      event.preventDefault();
      props.onOpenEntry(plugin.id);
    }}
  >
    <span class="plugin-catalog-result__icon" aria-hidden="true">
      ${categoryIcon(plugin.catalog.icon)}
    </span>
    <div class="plugin-catalog-result__identity">
      <div class="plugin-catalog-result__title-row">
        <h3>${plugin.catalog.name}</h3>
        ${firstCategory
          ? html`<span class="plugin-catalog-result__category">${firstCategory}</span>`
          : nothing}
      </div>
      <p>${plugin.catalog.summary || t("pluginsPage.optionalCapability")}</p>
      ${entryMeta(plugin)}
    </div>
    <span class="plugin-catalog-result__state" data-state=${plugin.local.state}>
      ${stateLabel(plugin)}
    </span>
    <span class="plugin-catalog-result__chevron" aria-hidden="true">${icons.chevronRight}</span>
  </a>`;
}

function intentLabel(intent: PluginDiscoveryIntent): string {
  if (intent === "trending") {
    return t("pluginsPage.intentTrending");
  }
  if (intent === "official") {
    return t("pluginsPage.intentOfficial");
  }
  return t("pluginsPage.intentAll");
}

function renderExplorer(props: PluginCatalogResultsProps): TemplateResult {
  const visibleItems = (props.result?.items ?? []).filter((plugin) => !plugin.local.enabled);
  return renderSettingsPage(
    html`
      <section class="plugin-catalog-results" aria-labelledby="plugin-catalog-results-title">
        <header class="plugin-catalog-results__header">
          <div>
            <h2 id="plugin-catalog-results-title">${t("pluginsPage.exploreTitle")}</h2>
            <p>${t("pluginsPage.exploreDescription")}</p>
          </div>
        </header>
        <div class="plugin-catalog-controls">
          <div
            class="plugin-catalog-intents"
            role="tablist"
            aria-label=${t("pluginsPage.viewsLabel")}
          >
            ${(["all", "trending", "official"] as const).map(
              (intent) => html`<button
                type="button"
                role="tab"
                aria-selected=${props.intent === intent}
                class="plugin-catalog-intent ${props.intent === intent ? "is-active" : ""}"
                @click=${() => props.onIntentChange(intent)}
              >
                ${intentLabel(intent)}
              </button>`,
            )}
          </div>
          <label class="plugin-catalog-search">
            <span aria-hidden="true">${icons.search}</span>
            <input
              type="search"
              class="oc-input"
              aria-label=${t("pluginsPage.searchClawHub")}
              placeholder=${t("pluginsPage.searchClawHub")}
              .value=${props.query}
              @input=${(event: Event) => {
                if (event.currentTarget instanceof HTMLInputElement) {
                  props.onQueryChange(event.currentTarget.value);
                }
              }}
            />
          </label>
        </div>
        ${renderCategories(props)}
        ${props.loading
          ? renderSettingsLoadingSkeleton({
              label: t("pluginsPage.loadingDiscovery"),
              rows: 6,
              carapace: true,
            })
          : props.error
            ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
                <span>${formatUiExternalText(props.error)}</span>
                <button
                  type="button"
                  class="btn btn--sm oc-action oc-action-secondary oc-banner-action"
                  @click=${props.onRetry}
                >
                  ${t("pluginsPage.tryAgain")}
                </button>
              </div>`
            : !props.connected
              ? html`<p class="plugin-catalog-results__empty">
                  ${t("pluginsPage.discoveryOffline")}
                </p>`
              : visibleItems.length === 0
                ? html`<p class="plugin-catalog-results__empty">
                    ${t("pluginsPage.noDiscoveryResults")}
                  </p>`
                : html`<div class="plugin-catalog-results__list">
                    ${repeat(
                      visibleItems,
                      (plugin) => plugin.id,
                      (plugin) => renderResultRow(plugin, props),
                    )}
                  </div>`}
        ${props.result?.nextCursor
          ? html`<div
              class="plugin-catalog-results__more"
              ${ref((element) => props.onLoadMoreTarget(element))}
            >
              <button
                type="button"
                class="btn btn--sm oc-action oc-action-ghost"
                ?disabled=${props.loadingMore}
                @click=${props.onLoadMore}
              >
                ${props.loadingMore ? t("pluginsPage.loadingMore") : t("pluginsPage.loadMore")}
              </button>
            </div>`
          : props.result && visibleItems.length > 0
            ? html`<p class="plugin-catalog-results__terminal">${t("pluginsPage.catalogEnd")}</p>`
            : nothing}
      </section>
    `,
    { wide: true, carapace: true },
  );
}

export function renderPluginCatalogResults(props: PluginCatalogResultsProps): TemplateResult {
  return html`${renderFeatured(props)}${renderExplorer(props)}`;
}

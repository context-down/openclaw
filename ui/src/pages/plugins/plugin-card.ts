import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";

export type PluginCardAttribution = {
  author?: string;
  official: boolean;
};

export function renderPluginOfficialBadge(): TemplateResult {
  return html`<span
    class="plugin-official-badge"
    aria-label=${t("pluginsPage.official")}
    title=${t("pluginsPage.official")}
    >${icons.badgeCheck}</span
  >`;
}

export function renderPluginAuthor(author: string | undefined): TemplateResult | typeof nothing {
  return author ? html`<span class="plugin-card-author">@${author}</span>` : nothing;
}

export function renderPluginCardIdentity(params: {
  name: string;
  attribution: PluginCardAttribution;
}): TemplateResult {
  return html`<div class="installed-plugins-card__identity">
    <div class="plugin-card-title-row">
      <h3>${params.name}</h3>
      ${params.attribution.official ? renderPluginOfficialBadge() : nothing}
    </div>
    ${renderPluginAuthor(params.attribution.author)}
  </div>`;
}

export function renderPluginCardSummary(summary: string): TemplateResult {
  return html`<p class="installed-plugins-card__summary">${summary}</p>`;
}

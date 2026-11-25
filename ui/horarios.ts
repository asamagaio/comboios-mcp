/**
 * MCP Apps view for the `horarios` tool: journey options as cards with a "Comprar" button.
 * Runs in the host's sandboxed iframe. It has no network access of its own: data arrives from the
 * tool result, and the buy button asks the host to open our purchase page (ui/open-link).
 * Bundled by esbuild into dist/ui/horarios.js and inlined into the ui:// resource.
 */
import { App } from "@modelcontextprotocol/ext-apps";

interface Leg { train: number | null; service: string | null; service_name: string | null; from: string | null; to: string | null; dep: string | null; arr: string | null }
interface Option {
  id: string; departure: string | null; arrival: string | null; arrives_next_day: boolean; duration: string | null;
  services: string[]; transfers: number; saleable_online: boolean;
  prices_eur: { regular?: number; promo_non_refundable?: number }; total_eur?: { regular?: number; promo_non_refundable?: number };
  legs: Leg[]; buy_url?: string;
}
interface Result {
  from: { name: string }; to: { name: string }; date: string; return_date?: string; travel_class: number; passengers: number;
  options: Option[]; return_options?: Option[]; messages?: { type: string | null; text: string }[]; cp_url?: string;
}

const root = document.getElementById("root")!;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const eur = (n?: number) => (n == null ? "" : `${n.toFixed(2).replace(".", ",")} €`);
const SERVICE: Record<string, string> = { AP: "Alfa Pendular", IC: "Intercidades", IR: "InterRegional", R: "Regional", U: "Urbano", IN: "Internacional" };

const app = new App({ name: "comboios-horarios", version: "0.1.0" }, {}, { autoResize: true });

function applyTheme() {
  const theme = app.getHostContext()?.theme;
  if (theme) document.documentElement.dataset.theme = theme;
}

function card(o: Option, passengers: number): string {
  const p = o.prices_eur;
  const price = p.promo_non_refundable != null
    ? `<span class="price">${eur(p.promo_non_refundable)}</span><span class="was">${eur(p.regular)}</span><span class="tag">promo, não reembolsável</span>`
    : `<span class="price">${eur(p.regular)}</span>`;
  const legs = o.legs.map((l) => `${esc(l.service ?? "")} ${esc(l.train ?? "")} · ${esc(l.dep)} ${esc(l.from)} → ${esc(l.arr)} ${esc(l.to)}`).join("<br>");
  const buy = o.buy_url
    ? `<button class="buy" data-url="${esc(o.buy_url)}">Comprar</button>`
    : o.saleable_online ? "" : `<span class="muted">Não vendido online</span>`;
  return `<article class="opt">
    <div class="times"><strong>${esc(o.departure)}</strong> → <strong>${esc(o.arrival)}</strong>${o.arrives_next_day ? ' <span class="tag">+1 dia</span>' : ""}</div>
    <div class="meta">${esc(o.duration)} · ${o.transfers === 0 ? "direto" : `${o.transfers} transbordo${o.transfers > 1 ? "s" : ""}`} · ${o.services.map((s) => `<span class="svc" title="${esc(SERVICE[s] ?? s)}">${esc(s)}</span>`).join(" ")}</div>
    <details><summary>Detalhes</summary><div class="legs">${legs}</div></details>
    <div class="row"><div>${price}${passengers > 1 ? `<span class="muted"> por pessoa</span>` : ""}</div>${buy}</div>
  </article>`;
}

function section(title: string, list: Option[], passengers: number): string {
  if (!list.length) return `<h2>${esc(title)}</h2><p class="muted">Sem comboios para estes critérios.</p>`;
  return `<h2>${esc(title)}</h2><div class="list">${list.map((o) => card(o, passengers)).join("")}</div>`;
}

function render(r: Result) {
  const head = `<header><div class="route">${esc(r.from.name)} → ${esc(r.to.name)}</div>
    <div class="muted">${esc(r.date)}${r.return_date ? ` · regresso ${esc(r.return_date)}` : ""} · ${r.travel_class}ª classe · ${r.passengers} passageiro${r.passengers > 1 ? "s" : ""}</div></header>`;
  const msgs = (r.messages ?? []).map((m) => `<p class="note">${esc(m.text)}</p>`).join("");
  root.innerHTML = head + msgs + section("Ida", r.options, r.passengers) +
    (r.return_options ? section("Regresso", r.return_options, r.passengers) : "") +
    `<footer class="muted">Serviço não oficial, sem garantias. Bilhetes emitidos e cobrados pela CP; o pagamento abre numa página à parte.</footer>`;
  root.querySelectorAll<HTMLButtonElement>("button.buy").forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try { await app.openLink({ url: b.dataset.url! }); } catch { window.open(b.dataset.url!, "_blank", "noopener"); }
      finally { b.disabled = false; }
    };
  });
}

app.ontoolinput = (params) => {
  const a = (params.arguments ?? {}) as Record<string, unknown>;
  root.innerHTML = `<p class="muted">A procurar comboios ${a.from ? `de ${esc(a.from)} ` : ""}${a.to ? `para ${esc(a.to)}` : ""}…</p>`;
};

app.ontoolresult = (result) => {
  const text = (result.content ?? []).find((c: any) => c.type === "text") as { text?: string } | undefined;
  try {
    const data = JSON.parse(text?.text ?? "{}");
    if (result.isError || data.error) {
      root.innerHTML = `<p class="err">${esc(data.error?.message ?? "Não foi possível obter os horários.")}</p>`;
      return;
    }
    render(data as Result);
  } catch {
    root.innerHTML = `<p class="err">Resposta inesperada.</p>`;
  }
};

app.onhostcontextchanged = () => applyTheme();

app.connect().then(applyTheme).catch(() => {
  root.innerHTML = `<p class="err">Este cliente não consegue mostrar a interface.</p>`;
});

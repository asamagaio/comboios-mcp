(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
  const fail = (msg) => { $("error").textContent = msg || "Ocorreu um erro."; show("loading", false); };
  const clearErr = () => { $("error").textContent = ""; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  async function api(action, body) {
    const r = await fetch(`/api/pay?a=${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Erro ${r.status}`);
    return j;
  }

  const params = new URLSearchParams(location.search);
  const isReturn = location.pathname.endsWith("/retorno");

  function renderTrip(q) {
    $("trip-title").textContent = `${q.from} → ${q.to}`;
    $("trip-when").textContent = `${q.date} · ${q.departure} → ${q.arrival} (${q.duration}) · ${q.travel_class}ª classe · ${q.passengers} passageiro(s)`;
    $("trip-legs").textContent = q.legs.map((l) => `${l.service || ""} ${l.train}: ${l.from} ${l.dep} → ${l.to} ${l.arr}`).join(" · ");
    $("trip-price").textContent = q.price_eur_each != null ? `${(q.price_eur_each * q.passengers).toFixed(2)} €` + (q.passengers > 1 ? ` (${q.price_eur_each.toFixed(2)} € cada)` : "") : "";
    show("trip-section");
  }

  function renderPassengers(n) {
    const box = $("passengers");
    for (let i = 0; i < n; i++) {
      box.insertAdjacentHTML("beforeend", `
        <label for="name-${i}">Nome do passageiro${n > 1 ? " " + (i + 1) : ""}</label>
        <input id="name-${i}" autocomplete="${i === 0 ? "name" : "off"}" required>
        <details><summary>Documento de identificação (opcional)</summary>
          <div class="row"><select id="idtype-${i}"><option value="">—</option><option value="CC">Cartão de Cidadão</option>
          <option value="PASS">Passaporte</option><option value="BI">BI</option><option value="AR">Autorização de Residência</option></select>
          <input id="idnum-${i}" placeholder="Número"></div>
        </details>`);
    }
  }

  async function loadCheckoutScript() {
    if (window.CheckoutWebComponents) return;
    await new Promise((ok, ko) => {
      const s = document.createElement("script");
      s.src = "https://checkout-web-components.checkout.com/index.js";
      s.onload = ok; s.onerror = () => ko(new Error("Não foi possível carregar o formulário de pagamento."));
      document.head.appendChild(s);
    });
  }

  async function startFlow(q) {
    clearErr();
    const passengers = [];
    for (let i = 0; i < q.passengers; i++) {
      const p = { name: $(`name-${i}`).value.trim() };
      const t = $(`idtype-${i}`).value; if (t) { p.idType = t; p.idNumber = $(`idnum-${i}`).value.trim(); }
      passengers.push(p);
    }
    const body = { option_id: q.option_id, passengers, email: $("email").value.trim(), mobile: $("mobile").value.trim() || undefined, consent: $("consent").checked };
    $("start").disabled = true;
    try {
      const s = await api("start", body);
      sessionStorage.setItem("cp_pay_token", s.token);
      localStorage.setItem("cp_pay_token", s.token); // in case the bank's 3-D Secure returns in another tab
      state.token = s.token; state.passengers = q.passengers;
      $("ref").textContent = s.reference; $("total").textContent = s.total;
      show("form-section", false); show("summary");
      wireCancel();
      const seated = (s.trains || []).filter((t) => t.seats.length);
      if (seated.length) { renderSeatStep(s.trains); show("seat-section"); }
      else await openPay();
    } catch (e) { fail(e.message); $("start").disabled = false; }
  }

  const state = { token: null, passengers: 1 };

  function wireCancel() {
    for (const id of ["cancel", "cancel-seat"]) {
      $(id).onclick = async () => {
        $(id).disabled = true;
        try {
          await api("cancel", { t: state.token });
          sessionStorage.removeItem("cp_pay_token"); localStorage.removeItem("cp_pay_token");
          show("pay-section", false); show("seat-section", false);
          $("result").innerHTML = `<p>Compra cancelada. Nada foi cobrado.</p>`; show("result-section");
        } catch (e) { fail(e.message); $(id).disabled = false; }
      };
    }
  }

  async function openPay() {
    clearErr();
    $("topay").disabled = true;
    try {
      const p = await api("pay", { t: state.token });
      show("seat-section", false); show("pay-section");
      if (p.total) $("total").textContent = p.total;
      await loadCheckoutScript();
      const cko = await window.CheckoutWebComponents({
        paymentSession: p.checkout.paymentSession, publicKey: p.checkout.publicKey, environment: p.checkout.environment,
        locale: "pt-PT",
        onPaymentCompleted: () => { location.href = `/comprar/retorno?t=${encodeURIComponent(state.token)}`; },
        onError: (_c, e) => fail("Pagamento não concluído: " + String((e && (e.message || e.type)) || "erro")),
      });
      cko.create("flow").mount("#flow");
    } catch (e) { fail(e.message); $("topay").disabled = false; }
  }

  // ------------------------------------------------------------ seats

  function seatsText(t) {
    return t.seats.length ? t.seats.map((x) => `carruagem ${x.carriage}, lugar ${x.seat}`).join(" · ") : "sem lugar marcado (lugar livre)";
  }

  function renderSeatStep(trains) {
    $("trains").innerHTML = trains.map((t, i) => `
      <div class="card" id="train-${i}">
        <div><strong>Comboio ${esc(t.train)}</strong> <span class="muted">${esc(t.from || "")} ${esc(t.dep || "")} → ${esc(t.to || "")} ${esc(t.arr || "")}</span></div>
        <div id="seats-${i}" style="margin-top:4px">${esc(seatsText(t))}</div>
        ${t.seats.length ? `<button class="secondary" id="choose-${i}">Escolher lugar${t.seats.length > 1 ? "es" : ""}</button><div id="map-${i}"></div>` : ""}
      </div>`).join("");
    trains.forEach((t, i) => { if (t.seats.length) $(`choose-${i}`).onclick = () => loadMap(t, i); });
    $("topay").onclick = openPay;
  }

  async function loadMap(t, i) {
    clearErr();
    const box = $(`map-${i}`);
    box.innerHTML = `<p class="muted">A carregar o mapa de lugares…</p>`;
    let m;
    try { m = await api("seats", { t: state.token, train: t.train }); } catch (e) { box.innerHTML = ""; return fail(e.message); }
    const mine = new Set(t.seats.map((x) => `${x.carriage}-${x.seat}`));
    const picked = [];
    let active = (m.carriages.find((c) => t.seats.some((x) => x.carriage === c.number)) || m.carriages[0]).number;
    const draw = () => {
      const c = m.carriages.find((x) => x.number === active);
      const tabs = m.carriages.map((x) => `<button class="tab${x.number === active ? " on" : ""}" data-c="${x.number}" ${x.occupancy >= 100 ? "disabled" : ""}>Carr. ${x.number}<br><small>${x.occupancy}% ocupada</small></button>`).join("");
      const rows = c.rows.map((r) => `<div class="srow">${r.map((p) => {
        if (p.kind === "empty") return `<span class="cell"></span>`;
        if (p.kind === "gap") return `<span class="cell gap"></span>`;
        const key = `${c.number}-${p.seat}`;
        const sel = picked.includes(key);
        const cls = sel ? "sel" : mine.has(key) ? "mine" : p.status;
        const can = (p.status === "free" || mine.has(key)) && p.changeable;
        const title = `Lugar ${p.seat}${p.table ? ", mesa" : ""}${p.plug ? ", tomada" : ""}${p.wheelchair ? ", mobilidade reduzida" : ""}${p.bike ? ", bicicleta" : ""}`;
        return `<button class="cell seat ${cls}${p.facing === "b" ? " fb" : ""}" data-k="${key}" title="${esc(title)}" ${can ? "" : "disabled"}>${p.seat}</button>`;
      }).join("")}</div>`).join("");
      $(`map-${i}`).innerHTML = `
        <div class="tabs">${tabs}</div>
        <div class="muted" style="margin:6px 0">${esc((c.attributes || []).join(" · "))}</div>
        <div class="smap">${rows}</div>
        <div class="legend"><span class="cell seat free"></span> livre <span class="cell seat occupied"></span> ocupado <span class="cell seat mine"></span> atual <span class="cell seat sel"></span> escolhido</div>
        <p class="muted">Escolha ${t.seats.length} lugar${t.seats.length > 1 ? "es" : ""} (${picked.length}/${t.seats.length}).</p>
        <button id="save-${i}" ${picked.length === t.seats.length ? "" : "disabled"}>Guardar lugar${t.seats.length > 1 ? "es" : ""}</button>`;
      $(`map-${i}`).querySelectorAll(".tab").forEach((b) => (b.onclick = () => { active = Number(b.dataset.c); draw(); }));
      $(`map-${i}`).querySelectorAll(".seat[data-k]").forEach((b) => (b.onclick = () => {
        const k = b.dataset.k; const at = picked.indexOf(k);
        if (at >= 0) picked.splice(at, 1); else { if (picked.length >= t.seats.length) picked.shift(); picked.push(k); }
        draw();
      }));
      $(`save-${i}`).onclick = async () => {
        $(`save-${i}`).disabled = true;
        try {
          const seats = picked.map((k) => { const [carriage, seat] = k.split("-").map(Number); return { carriage, seat }; });
          const r = await api("seat", { t: state.token, train: t.train, seats });
          const nt = (r.trains || []).find((x) => x.train === t.train);
          if (nt) { t.seats = nt.seats; $(`seats-${i}`).textContent = seatsText(nt); }
          if (r.total) $("total").textContent = r.total;
          $(`map-${i}`).innerHTML = `<p class="ok">Lugar atualizado.</p>`;
        } catch (e) { fail(e.message); $(`save-${i}`).disabled = false; }
      };
    };
    draw();
  }

  /** Details sent by the assistant arrive encrypted (f=...); fill the form and drop f from the address bar. */
  async function applyPrefill(f, n) {
    if (!f) return;
    const clean = new URL(location.href); clean.searchParams.delete("f");
    history.replaceState(null, "", clean.pathname + clean.search);
    try {
      const p = await api("prefill", { f });
      (p.passengers || []).slice(0, n).forEach((name, i) => { $(`name-${i}`).value = name; });
      if (p.email) $("email").value = p.email;
      if (p.mobile) $("mobile").value = p.mobile;
      $("form-section").insertAdjacentHTML("afterbegin", `<p class="muted">Dados preenchidos pelo assistente. Confirme que estão corretos antes de continuar.</p>`);
    } catch (e) {
      $("form-section").insertAdjacentHTML("afterbegin", `<p class="muted">${esc(e.message)}</p>`);
    }
  }

  async function confirmFlow(token) {
    show("loading", true); $("loading").textContent = "A confirmar o pagamento com a CP…";
    for (let attempt = 0; attempt < 6; attempt++) {
      let r;
      try { r = await api("confirm", { t: token }); } catch (e) { return fail(e.message); }
      if (r.confirmed) {
        show("loading", false);
        $("result").innerHTML = `<p class="ok">Bilhete emitido. Referência ${esc(r.reference)} · ${esc(r.total)}</p><p class="muted">A CP também envia o bilhete por email.</p>`;
        $("tickets").innerHTML = (r.tickets || []).filter((t) => t.ticketID).map((t) =>
          `<p><a href="/api/pay?a=ticket&t=${encodeURIComponent(token)}&id=${encodeURIComponent(t.ticketID)}" target="_blank" rel="noopener">Bilhete ${esc(t.ticketID)} (PDF)</a></p>`).join("");
        show("result-section");
        localStorage.removeItem("cp_pay_token");
        return;
      }
      if (r.needs_attention) {
        show("loading", false);
        $("result").innerHTML = `<p class="err">${esc(r.message)}</p><p>Referência: <strong>${esc(r.reference)}</strong></p>`;
        show("result-section");
        return;
      }
      await new Promise((ok) => setTimeout(ok, 5000)); // payment not registered yet (e.g. MB WAY pending)
    }
    show("loading", false);
    $("result").innerHTML = `<p>O pagamento ainda não aparece como concluído. Se já pagou, recarregue esta página daqui a um minuto. Não pague novamente.</p>`;
    show("result-section");
  }

  (async () => {
    try {
      if (isReturn) {
        const token = params.get("t") || sessionStorage.getItem("cp_pay_token") || localStorage.getItem("cp_pay_token");
        if (!token) return fail("Não encontrei a compra neste navegador. Se pagou, o bilhete foi enviado por email pela CP.");
        return await confirmFlow(token);
      }
      const o = params.get("o");
      if (!o) return fail("Falta a viagem (parâmetro o).");
      const q = await api("quote", { option_id: o });
      show("loading", false);
      renderTrip(q); renderPassengers(q.passengers); show("form-section");
      await applyPrefill(params.get("f"), q.passengers);
      $("start").onclick = () => startFlow(q);
    } catch (e) { fail(e.message); }
  })();
})();

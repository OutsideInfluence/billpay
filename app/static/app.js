"use strict";

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const state = { settings: null, periodDate: null, billFilter: "active", user: null };

// ---------- utilities ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const money = (n) => fmt.format(Number(n) || 0);
const shortMoney = (n) => (Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : `$${Math.round(n)}`);
const toDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayIso = () => iso(new Date());
const dLong = (s) => toDate(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const dFull = (s) => toDate(s).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const ordinal = (n) => n + (["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : (n % 10 < 4 ? n % 10 : 0)] || "th");

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "X-Requested-With": "BillPay", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.auth) {
    showAuth("login", "Your session ended. Sign in again.");
    throw new Error(data.error);
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------- modal ----------
const modal = $("#modal");
function openModal({ title, body, actions, onSubmit }) {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  $("#modal-actions").innerHTML = actions;
  $("#modal-error").textContent = "";
  const form = $("#modal-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    try {
      await onSubmit(new FormData(form), btn?.value || "save");
      modal.close();
    } catch (err) {
      $("#modal-error").textContent = err.message;
    }
  };
  modal.showModal();
  const first = $("#modal-body input, #modal-body select");
  if (first && window.matchMedia("(min-width: 761px)").matches) first.focus();
}
modal.addEventListener("click", (e) => {
  if (e.target === modal || e.target.closest("[data-close]")) modal.close();
});


// ---------- sign in / first-run setup ----------
const authEl = $("#auth");
const shellEl = $("#shell");

function showAuth(mode, notice = "") {
  if (modal.open) modal.close();
  state.user = null;
  state.settings = null;
  shellEl.hidden = true;
  authEl.hidden = false;
  const setup = mode === "setup";
  authEl.innerHTML = `
    <div class="panel auth-card">
      <div class="brand">BillPay</div>
      <p>${setup ? "Create the first account. You can add your wife's account in Settings afterwards." : "Sign in to see your bills."}</p>
      <form id="auth-form" novalidate>
        ${setup ? `<label class="field">Your name<input name="display_name" autocomplete="name" required></label>` : ""}
        <label class="field">Username<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
        <label class="field">Password<input name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" required>
          ${setup ? '<span class="hint">At least 10 characters</span>' : ""}</label>
        ${setup ? `<label class="field">Repeat password<input name="password2" type="password" autocomplete="new-password" required></label>`
                : `<label class="toggle"><input type="checkbox" name="remember" checked> Keep me signed in on this device</label>`}
        <p class="form-error" role="alert">${esc(notice)}</p>
        <button class="btn primary">${setup ? "Create account" : "Sign in"}</button>
      </form>
    </div>`;
  const form = $("#auth-form");
  form.querySelector("input").focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = form.querySelector(".form-error");
    const fd = Object.fromEntries(new FormData(form).entries());
    if (setup && fd.password !== fd.password2) { err.textContent = "The passwords don't match."; return; }
    const btn = form.querySelector("button");
    btn.disabled = true;
    try {
      const r = await api(setup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        body: { ...fd, remember: setup ? true : form.remember.checked },
      });
      enterApp(r.user);
    } catch (ex) {
      err.textContent = ex.message;
      form.password.value = "";
      form.password.focus();
    } finally { btn.disabled = false; }
  });
}

function enterApp(user) {
  state.user = user;
  authEl.hidden = true;
  authEl.innerHTML = "";
  shellEl.hidden = false;
  $("#nav-user").innerHTML = `Signed in as <strong>${esc(user.display_name)}</strong><button type="button" data-signout>Sign out</button>`;
  route();
}

async function signOut() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  state.periodDate = null;
  showAuth("login");
}

async function boot() {
  try {
    const st = await api("/api/auth/status");
    if (st.user) enterApp(st.user);
    else showAuth(st.setup_needed ? "setup" : "login");
  } catch (ex) {
    authEl.hidden = false;
    authEl.innerHTML = `<div class="panel auth-card"><div class="brand">BillPay</div><p>Couldn't reach the server: ${esc(ex.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
  }
}

// ---------- router ----------
const routes = { "": renderDashboard, bills: renderBills, income: renderIncome, settings: renderSettings };
async function route() {
  if (!state.user) return;
  const key = location.hash.replace(/^#\/?/, "").split("?")[0];
  const fn = routes[key] || renderDashboard;
  const name = routes[key] ? (key || "dashboard") : "dashboard";
  document.querySelectorAll(".nav a").forEach((a) => {
    if (a.dataset.view === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  if (!state.settings) state.settings = await api("/api/settings");
  try {
    await fn();
  } catch (err) {
    view.innerHTML = `<div class="panel empty"><p>Couldn't load this page: ${esc(err.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
}
window.addEventListener("hashchange", route);

// ---------- dashboard ----------
function billStatus(b, today) {
  if (b.payment) return { cls: "paid", label: `Paid ${dLong(b.payment.paid_on)}` };
  if (b.autopay) return { cls: "auto", label: b.due_date < today ? "Autopaid" : "Autopay" };
  if (b.due_date < today) return { cls: "late", label: "Past due" };
  const days = Math.round((toDate(b.due_date) - toDate(today)) / 864e5);
  if (days === 0) return { cls: "due", label: "Due today" };
  if (days <= 3) return { cls: "due", label: `Due in ${days} day${days > 1 ? "s" : ""}` };
  return { cls: "", label: `Due ${dLong(b.due_date)}` };
}

function billRow(b, today) {
  const st = billStatus(b, today);
  const d = toDate(b.due_date);
  const isPaid = !!b.payment;
  return `
    <li class="bill-row ${isPaid ? "is-paid" : ""}">
      <div class="check-cell">
        <input type="checkbox" class="check" ${isPaid ? "checked" : ""} data-pay="${b.id}" data-due="${b.due_date}"
          aria-label="${isPaid ? "Mark unpaid" : "Mark paid"}: ${esc(b.creditor)}">
        <div class="when"><span class="m">${d.toLocaleDateString(undefined, { month: "short" })}</span><span class="d">${d.getDate()}</span></div>
      </div>
      <div class="who">
        <strong>${esc(b.creditor)}</strong>
        <div class="meta">
          <span class="tag ${st.cls}">${st.label}</span>
          ${b.description ? `<span>${esc(b.description)}</span>` : ""}
          ${b.account_hint ? `<span>••${esc(b.account_hint)}</span>` : ""}
        </div>
      </div>
      <div class="right">
        <span class="money">${money(isPaid ? b.payment.amount : b.amount)}</span>
        <div class="actions">
          ${b.website ? `<a class="btn small" href="${esc(b.website)}" target="_blank" rel="noopener noreferrer">Pay online</a>` : ""}
          <button class="btn small" data-bill-detail="${b.id}" data-due="${b.due_date}">Details</button>
        </div>
      </div>
      <div class="mobile-actions">
        ${b.website ? `<a class="btn small" href="${esc(b.website)}" target="_blank" rel="noopener noreferrer">Pay online</a>` : ""}
        <button class="btn small" data-bill-detail="${b.id}" data-due="${b.due_date}">Details</button>
      </div>
    </li>`;
}

async function renderDashboard() {
  const qDate = state.periodDate || todayIso();
  const p = await api(`/api/period?date=${qDate}`);
  state.lastPeriod = p;
  const { totals, today } = p;
  const s = state.settings;

  // Build the day strip
  const days = [];
  for (let d = toDate(p.start); d <= toDate(p.end); d.setDate(d.getDate() + 1)) days.push(iso(d));
  const byDay = {};
  p.bills.forEach((b) => (byDay[b.due_date] ||= []).push(b));
  const depByDay = {};
  p.income.forEach((i) => (depByDay[i.deposit_date] = (depByDay[i.deposit_date] || 0) + i.amount));

  const strip = days.map((d) => {
    const dt = toDate(d);
    const payday = d === p.start;
    const chips = (byDay[d] || []).map((b) => {
      const st = billStatus(b, today);
      return `<button class="chip ${st.cls}" data-bill-detail="${b.id}" data-due="${b.due_date}" title="${esc(b.creditor)} ${money(b.amount)}">${esc(b.creditor)}</button>`;
    }).join("");
    return `<div class="day ${payday ? "payday" : ""} ${d === today ? "today" : ""}" ${d === today ? 'aria-current="date"' : ""}>
      <span class="dow">${dt.toLocaleDateString(undefined, { weekday: "short" })}</span>
      <span class="num">${dt.getDate()}</span>
      ${payday ? `<span class="pay-mark">Payday</span>` : ""}
      ${depByDay[d] && !payday ? `<span class="pay-mark" style="color:var(--paid)">+${shortMoney(depByDay[d])}</span>` : ""}
      ${chips}
    </div>`;
  }).join("");

  const pct = totals.due ? Math.min(100, Math.round((totals.paid / totals.due) * 100)) : 0;
  const isCurrent = today >= p.start && today <= p.end;
  const leftCls = totals.left_over < 0 ? "neg" : "pos";

  view.innerHTML = `
    <div class="period-head">
      <button class="icon-btn" data-nav="${p.prev}" aria-label="Previous pay period">‹</button>
      <h1>${dLong(p.start)} – ${dFull(p.end)}</h1>
      <button class="icon-btn" data-nav="${p.next}" aria-label="Next pay period">›</button>
    </div>
    <p class="period-sub">${isCurrent ? "Current pay period" : `<a href="#/" data-nav="today">Back to the current pay period</a>`} · ${p.bills.length} bill${p.bills.length === 1 ? "" : "s"} due</p>

    <div class="strip-wrap"><div class="strip" style="--days:${days.length}">${strip}</div></div>

    <div class="panel ledger">
      <span><small>Deposited</small><b>${money(totals.income)}</b></span>
      <span class="op">−</span>
      <span><small>Bills due</small><b>${money(totals.due)}</b></span>
      <span class="op">=</span>
      <span><small>Left over</small><b class="${leftCls}">${money(totals.left_over)}</b></span>
      <div class="progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Bills paid"><span style="width:${pct}%"></span></div>
      <small>${money(totals.paid)} paid · ${money(totals.remaining_to_pay)} still to pay</small>
    </div>

    ${p.overdue.length ? `
      <section class="panel overdue-panel">
        <h2>Unpaid from earlier</h2>
        <ul class="bill-list">${p.overdue.map((b) => billRow(b, today)).join("")}</ul>
      </section>` : ""}

    <div class="grid-2">
      <section>
        <div class="section-title"><h2>Bills this period</h2><button class="btn small" data-add-bill>Add bill</button></div>
        <div class="panel">
          ${p.bills.length ? `<ul class="bill-list">${p.bills.map((b) => billRow(b, today)).join("")}</ul>`
            : `<div class="empty"><p>No bills fall in this pay period.</p><button class="btn primary" data-add-bill>Add a bill</button></div>`}
        </div>
      </section>
      <section>
        <div class="section-title"><h2>Deposits</h2><button class="btn small primary" data-add-income>Add paycheck</button></div>
        <div class="panel">
          ${p.income.length ? `<ul class="bill-list income-list">${p.income.map((i) => `
            <li><div><strong>${esc(i.earner)}</strong><div class="muted" style="font-size:.85rem">${dFull(i.deposit_date)}${i.note ? ` · ${esc(i.note)}` : ""}</div></div>
            <span class="money">${money(i.amount)}</span></li>`).join("")}</ul>`
            : `<div class="empty"><p>No paychecks recorded for this period yet.</p></div>`}
        </div>
      </section>
    </div>`;
}

// ---------- bills page ----------
async function renderBills() {
  const bills = await api("/api/bills");
  const shown = bills.filter((b) => state.billFilter === "all" || (state.billFilter === "active" ? b.active : !b.active));
  const monthly = bills.filter((b) => b.active).reduce((a, b) => a + b.amount, 0);
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Bills</h1><p>${bills.filter((b) => b.active).length} active · ${money(monthly)} per month</p></div>
      <button class="btn primary" data-add-bill>Add bill</button>
    </div>
    <div class="filters"><div class="seg" role="group" aria-label="Filter bills">
      ${["active", "inactive", "all"].map((f) => `<button data-filter="${f}" aria-pressed="${state.billFilter === f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join("")}
    </div></div>
    <div class="panel">
      ${shown.length ? `<div class="table-wrap"><table class="cards">
        <thead><tr><th>Creditor</th><th>Due</th><th data-hide-mobile>Category</th><th class="num">Amount</th><th></th></tr></thead>
        <tbody>${shown.map((b) => `
          <tr class="${b.active ? "" : "inactive"}">
            <td><strong>${esc(b.creditor)}</strong>${b.description ? `<div class="muted" style="font-size:.85rem">${esc(b.description)}</div>` : ""}</td>
            <td class="num" style="text-align:inherit">${ordinal(b.due_day)} ${b.autopay ? '<span class="tag auto">Autopay</span>' : ""}${b.active ? "" : ' <span class="tag">Inactive</span>'}</td>
            <td data-hide-mobile>${esc(b.category) || '<span class="muted">—</span>'}</td>
            <td class="num money">${money(b.amount)}</td>
            <td class="actions-cell" style="text-align:right;white-space:nowrap">
              ${b.website ? `<a class="btn small" href="${esc(b.website)}" target="_blank" rel="noopener noreferrer">Pay online</a>` : ""}
              <button class="btn small" data-edit-bill="${b.id}">Edit</button>
            </td>
          </tr>`).join("")}</tbody></table></div>`
        : `<div class="empty"><p>${bills.length ? "No bills match this filter." : "Add your first monthly bill to start planning each pay period."}</p>${bills.length ? "" : '<button class="btn primary" data-add-bill>Add bill</button>'}</div>`}
    </div>`;
  state.billsCache = bills;
}

function billForm(b = {}) {
  return `<div class="form-grid">
    <label class="field full">Creditor<input name="creditor" required value="${esc(b.creditor)}" placeholder="e.g. City Water"></label>
    <label class="field">Amount<input name="amount" type="number" step="0.01" min="0" inputmode="decimal" required value="${b.amount ?? ""}"></label>
    <label class="field">Due day of month<input name="due_day" type="number" min="1" max="31" inputmode="numeric" required value="${b.due_day ?? ""}">
      <span class="hint">Use 31 for the last day of the month</span></label>
    <label class="field full">Payment website<input name="website" type="url" inputmode="url" value="${esc(b.website)}" placeholder="https://"></label>
    <label class="field">Description<input name="description" value="${esc(b.description)}" placeholder="e.g. Car loan"></label>
    <label class="field">Category<input name="category" list="cats" value="${esc(b.category)}" placeholder="e.g. Utilities">
      <datalist id="cats">${["Housing", "Utilities", "Insurance", "Loans", "Credit cards", "Subscriptions", "Phone & internet", "Medical", "Other"].map((c) => `<option value="${c}">`).join("")}</datalist></label>
    <label class="field">Account (last 4 only)<input name="account_hint" maxlength="4" inputmode="numeric" value="${esc(b.account_hint)}">
      <span class="hint">Never store full account numbers or passwords</span></label>
    <label class="field">First due month<input name="start_date" type="month" value="${(b.start_date || todayIso()).slice(0, 7)}"></label>
    <label class="toggle"><input type="checkbox" name="autopay" ${b.autopay ? "checked" : ""}> Paid automatically</label>
    ${b.id ? `<label class="toggle"><input type="checkbox" name="active" ${b.active ? "checked" : ""}> Active</label>` : ""}
    <label class="field full">Notes<textarea name="notes">${esc(b.notes)}</textarea></label>
  </div>`;
}

function readBill(fd, isEdit) {
  const o = Object.fromEntries(fd.entries());
  o.autopay = fd.has("autopay");
  if (isEdit) o.active = fd.has("active");
  o.start_date = o.start_date ? `${o.start_date}-01` : undefined;
  return o;
}

function openBill(b) {
  const isEdit = !!b?.id;
  openModal({
    title: isEdit ? "Edit bill" : "Add bill",
    body: billForm(b || {}),
    actions: `${isEdit ? '<button class="btn danger" value="delete" formnovalidate>Delete bill</button><span class="spacer"></span>' : ""}
      <button type="button" class="btn" data-close>Cancel</button>
      <button class="btn primary" value="save">${isEdit ? "Save changes" : "Add bill"}</button>`,
    onSubmit: async (fd, action) => {
      if (action === "delete") {
        if (!confirm(`Delete ${b.creditor} and its payment history?`)) throw new Error("Delete cancelled.");
        await api(`/api/bills/${b.id}`, { method: "DELETE" });
        toast("Bill deleted");
      } else {
        const body = readBill(fd, isEdit);
        await api(isEdit ? `/api/bills/${b.id}` : "/api/bills", { method: isEdit ? "PUT" : "POST", body });
        toast(isEdit ? "Changes saved" : "Bill added");
      }
      route();
    },
  });
}

function openBillDetail(billId, due) {
  const all = [...(state.lastPeriod?.bills || []), ...(state.lastPeriod?.overdue || [])];
  const b = all.find((x) => x.id === billId && x.due_date === due);
  if (!b) return;
  const paid = !!b.payment;
  openModal({
    title: b.creditor,
    body: `<p class="muted" style="margin-top:0">${b.description ? esc(b.description) + " · " : ""}Due ${dFull(b.due_date)}${b.account_hint ? ` · ••${esc(b.account_hint)}` : ""}</p>
      ${b.website ? `<p><a class="btn" href="${esc(b.website)}" target="_blank" rel="noopener noreferrer">Open payment site</a></p>` : ""}
      ${b.notes ? `<p style="white-space:pre-wrap">${esc(b.notes)}</p>` : ""}
      <div class="form-grid">
        <label class="field">Amount paid<input name="amount" type="number" step="0.01" min="0" inputmode="decimal" value="${paid ? b.payment.amount : b.amount}"></label>
        <label class="field">Paid on<input name="paid_on" type="date" value="${paid ? b.payment.paid_on : todayIso()}"></label>
      </div>`,
    actions: `<button class="btn" value="edit" formnovalidate>Edit bill</button><span class="spacer"></span>
      ${paid ? '<button class="btn danger" value="unpay">Mark unpaid</button>' : ""}
      <button class="btn primary" value="pay">${paid ? "Update payment" : "Mark paid"}</button>`,
    onSubmit: async (fd, action) => {
      if (action === "edit") {
        const full = await api("/api/bills").then((l) => l.find((x) => x.id === b.id));
        setTimeout(() => openBill(full), 0);
        return;
      }
      if (action === "unpay") {
        await api("/api/payments", { method: "DELETE", body: { bill_id: b.id, due_date: b.due_date } });
        toast("Marked unpaid");
      } else {
        await api("/api/payments", { method: "POST", body: { bill_id: b.id, due_date: b.due_date, amount: fd.get("amount"), paid_on: fd.get("paid_on") } });
        toast("Marked paid");
      }
      route();
    },
  });
}

// ---------- income page ----------
async function renderIncome() {
  const list = await api("/api/income");
  const s = state.settings;
  const byMonth = {};
  list.forEach((i) => { const k = i.deposit_date.slice(0, 7); (byMonth[k] ||= []).push(i); });
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Income</h1><p>Record each paycheck when it lands in your account.</p></div>
      <button class="btn primary" data-add-income>Add paycheck</button>
    </div>
    ${list.length ? Object.entries(byMonth).map(([m, items]) => {
      const label = toDate(m + "-01").toLocaleDateString(undefined, { month: "long", year: "numeric" });
      const sum = (who) => items.filter((i) => who == null || i.earner === who).reduce((a, i) => a + i.amount, 0);
      return `<section style="margin-bottom:24px">
        <div class="section-title"><h2>${label}</h2><span class="money">${money(sum())}</span></div>
        <div class="panel"><div class="table-wrap"><table class="cards">
          <thead><tr><th>Date</th><th>Who</th><th data-hide-mobile>Note</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${items.map((i) => `<tr>
            <td>${dLong(i.deposit_date)}</td>
            <td class="num" style="text-align:inherit"><strong>${esc(i.earner)}</strong></td>
            <td data-hide-mobile class="muted">${esc(i.note)}</td>
            <td class="num money">${money(i.amount)}</td>
            <td class="actions-cell" style="text-align:right"><button class="btn small" data-edit-income="${i.id}">Edit</button></td>
          </tr>`).join("")}</tbody></table></div></div>
        <p class="muted" style="font-size:.85rem;margin:8px 4px 0">${esc(s.person1)}: ${money(sum(s.person1))} · ${esc(s.person2)}: ${money(sum(s.person2))}</p>
      </section>`;
    }).join("") : `<div class="panel empty"><p>No paychecks yet. Add one each time a deposit hits your account.</p><button class="btn primary" data-add-income>Add paycheck</button></div>`}`;
  state.incomeCache = list;
}

function openIncome(i) {
  const s = state.settings;
  const isEdit = !!i?.id;
  const last = state.incomeCache?.[0];
  const earner = i?.earner || s.person1;
  openModal({
    title: isEdit ? "Edit paycheck" : "Add paycheck",
    body: `<div class="form-grid">
      <label class="field full">Who was paid
        <select name="earner">${[s.person1, s.person2, ...(i && ![s.person1, s.person2].includes(i.earner) ? [i.earner] : [])]
          .map((n) => `<option ${n === earner ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <label class="field">Amount deposited<input name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" required value="${i?.amount ?? ""}" placeholder="${last ? last.amount : ""}"></label>
      <label class="field">Deposit date<input name="deposit_date" type="date" required value="${i?.deposit_date || todayIso()}"></label>
      <label class="field full">Note<input name="note" value="${esc(i?.note)}" placeholder="Optional, e.g. includes bonus"></label>
    </div>`,
    actions: `${isEdit ? '<button class="btn danger" value="delete" formnovalidate>Delete</button><span class="spacer"></span>' : ""}
      <button type="button" class="btn" data-close>Cancel</button>
      <button class="btn primary" value="save">${isEdit ? "Save changes" : "Add paycheck"}</button>`,
    onSubmit: async (fd, action) => {
      if (action === "delete") {
        await api(`/api/income/${i.id}`, { method: "DELETE" });
        toast("Paycheck deleted");
      } else {
        const body = Object.fromEntries(fd.entries());
        await api(isEdit ? `/api/income/${i.id}` : "/api/income", { method: isEdit ? "PUT" : "POST", body });
        toast(isEdit ? "Changes saved" : "Paycheck added");
      }
      route();
    },
  });
}

// ---------- settings ----------
async function renderSettings() {
  const s = state.settings = await api("/api/settings");
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1></div></div>
    <form id="settings-form">
      <section class="panel settings-panel">
        <h2>People</h2>
        <div class="form-grid">
          <label class="field">First person<input name="person1" value="${esc(s.person1)}" required></label>
          <label class="field">Second person<input name="person2" value="${esc(s.person2)}" required></label>
        </div>
      </section>
      <section class="panel settings-panel">
        <h2>Pay periods</h2>
        <p>The dashboard groups bills into the period between paydays.</p>
        <div class="form-grid">
          <label class="field">Pay schedule
            <select name="pay_schedule">
              <option value="biweekly" ${s.pay_schedule === "biweekly" ? "selected" : ""}>Every 2 weeks</option>
              <option value="semimonthly" ${s.pay_schedule === "semimonthly" ? "selected" : ""}>1st and 15th</option>
            </select></label>
          <label class="field" id="anchor-field">A recent payday<input name="payday_anchor" type="date" value="${esc(s.payday_anchor)}">
            <span class="hint">Any past or upcoming payday works</span></label>
        </div>
      </section>
      <p style="margin-top:20px"><button class="btn primary">Save settings</button></p>
    </form>

    <section class="panel settings-panel" style="margin-top:32px">
      <h2>Your account</h2>
      <form id="me-form" novalidate>
        <div class="form-grid">
          <label class="field">Name<input name="display_name" value="${esc(state.user.display_name)}" autocomplete="name"></label>
          <label class="field">Username<input value="${esc(state.user.username)}" disabled></label>
          <label class="field full">Current password<input name="current_password" type="password" autocomplete="current-password">
            <span class="hint">Only needed to change your password</span></label>
          <label class="field">New password<input name="new_password" type="password" autocomplete="new-password"></label>
          <label class="field">Repeat new password<input name="new_password2" type="password" autocomplete="new-password"></label>
        </div>
        <p class="form-error" style="margin:12px 0 0" role="alert"></p>
        <p style="margin:16px 0 0;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn primary">Save account</button>
          <button type="button" class="btn" data-signout>Sign out</button>
        </p>
      </form>
    </section>

    <section class="panel settings-panel">
      <h2>Household accounts</h2>
      <p>Everyone listed here sees and edits the same bills and income.</p>
      <ul class="user-list" id="user-list"><li class="muted">Loading…</li></ul>
      <button class="btn" data-add-user>Add account</button>
    </section>`;
  const form = $("#settings-form");
  const sync = () => ($("#anchor-field").style.display = form.pay_schedule.value === "biweekly" ? "" : "none");
  form.pay_schedule.addEventListener("change", sync);
  sync();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      state.settings = await api("/api/settings", { method: "PUT", body: Object.fromEntries(new FormData(form).entries()) });
      toast("Settings saved");
    } catch (err) { toast(err.message); }
  });

  const me = $("#me-form");
  me.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = me.querySelector(".form-error");
    const fd = Object.fromEntries(new FormData(me).entries());
    err.textContent = "";
    if (fd.new_password && fd.new_password !== fd.new_password2) { err.textContent = "The new passwords don't match."; return; }
    if (fd.new_password && !fd.current_password) { err.textContent = "Enter your current password to set a new one."; return; }
    try {
      const r = await api("/api/users/me", { method: "PUT", body: fd });
      state.user = r.user;
      $("#nav-user strong").textContent = r.user.display_name;
      ["current_password", "new_password", "new_password2"].forEach((n) => (me[n].value = ""));
      toast(fd.new_password ? "Password changed. Other devices were signed out." : "Account saved");
    } catch (ex) { err.textContent = ex.message; }
  });
  loadUsers();
}

async function loadUsers() {
  const users = await api("/api/users");
  $("#user-list").innerHTML = users.map((u) => `
    <li><div><strong>${esc(u.display_name)}</strong><div class="muted">${esc(u.username)}${u.id === state.user.id ? " · you" : ""}</div></div>
    ${u.id === state.user.id ? "" : `<button class="btn small danger" data-remove-user="${u.id}" data-name="${esc(u.display_name)}">Remove</button>`}</li>`).join("");
}

function openAddUser() {
  openModal({
    title: "Add account",
    body: `<p class="muted" style="margin-top:0">They'll share all bills and income with you. Give them the username and password to sign in.</p>
      <div class="form-grid">
        <label class="field full">Name<input name="display_name" required autocomplete="off"></label>
        <label class="field full">Username<input name="username" required autocapitalize="none" spellcheck="false" autocomplete="off"></label>
        <label class="field">Password<input name="password" type="password" required autocomplete="new-password"><span class="hint">At least 10 characters</span></label>
        <label class="field">Repeat password<input name="password2" type="password" required autocomplete="new-password"></label>
      </div>`,
    actions: `<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" value="save">Add account</button>`,
    onSubmit: async (fd) => {
      const body = Object.fromEntries(fd.entries());
      if (body.password !== body.password2) throw new Error("The passwords don't match.");
      await api("/api/users", { method: "POST", body });
      toast("Account added");
      loadUsers();
    },
  });
}

// ---------- global click handling ----------
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-signout]")) { signOut(); return; }
  if (e.target.closest("[data-add-user]")) { openAddUser(); return; }
  const ru = e.target.closest("[data-remove-user]");
  if (ru) {
    if (!confirm(`Remove ${ru.dataset.name}'s account? Your bills and income stay as they are.`)) return;
    try { await api(`/api/users/${ru.dataset.removeUser}`, { method: "DELETE" }); toast("Account removed"); loadUsers(); }
    catch (ex) { toast(ex.message); }
    return;
  }
  const t = e.target.closest("[data-nav],[data-add-bill],[data-edit-bill],[data-bill-detail],[data-add-income],[data-edit-income],[data-filter]");
  if (!t) return;
  if (t.dataset.nav) {
    e.preventDefault();
    state.periodDate = t.dataset.nav === "today" ? null : t.dataset.nav;
    renderDashboard();
  } else if (t.hasAttribute("data-add-bill")) openBill();
  else if (t.dataset.editBill) openBill(state.billsCache.find((b) => b.id === +t.dataset.editBill));
  else if (t.dataset.billDetail) openBillDetail(+t.dataset.billDetail, t.dataset.due);
  else if (t.hasAttribute("data-add-income")) {
    if (!state.incomeCache) state.incomeCache = await api("/api/income");
    openIncome();
  } else if (t.dataset.editIncome) openIncome(state.incomeCache.find((i) => i.id === +t.dataset.editIncome));
  else if (t.dataset.filter) { state.billFilter = t.dataset.filter; renderBills(); }
});

document.addEventListener("change", async (e) => {
  const c = e.target.closest("[data-pay]");
  if (!c) return;
  const body = { bill_id: +c.dataset.pay, due_date: c.dataset.due };
  try {
    if (c.checked) { await api("/api/payments", { method: "POST", body }); toast("Marked paid"); }
    else { await api("/api/payments", { method: "DELETE", body }); toast("Marked unpaid"); }
  } catch (err) { toast(err.message); }
  renderDashboard();
});

boot();

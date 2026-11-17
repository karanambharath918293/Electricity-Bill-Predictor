"use strict";

const PRESETS = { "Ceiling Fan": 75, "LED Bulb": 9, "Tube Light": 40, "Refrigerator": 150, "TV (LED)": 100, "AC 1.5 Ton": 1500, "Washing Machine": 500, "Water Heater/Geyser": 2000, Laptop: 65, "Phone Charger": 10, "Water Pump": 750, "Mixer Grinder": 500, Iron: 1000, Microwave: 1200 };
const DEFAULT_SLABS = [{ upto: 100, rate: 3 }, { upto: 200, rate: 5 }, { upto: 400, rate: 7 }, { upto: null, rate: 9 }];
let appliances = [];
let slabs = structuredClone(DEFAULT_SLABS);
let history = [];
let syncTimer;
let syncing = false;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: "same-origin", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) {
    if (response.status === 401) window.location.assign("login.html");
    throw new Error(result.error || "Could not save your changes.");
  }
  return result;
}

async function initialize() {
  try {
    const [account, dashboard] = await Promise.all([api("/api/me"), api("/api/dashboard")]);
    const firstName = account.user.name.trim().split(/\s+/)[0];
    document.getElementById("user-avatar").textContent = (firstName[0] || "W").toUpperCase();
    document.getElementById("user-avatar").title = account.user.name;
    appliances = dashboard.appliances || [];
    slabs = dashboard.slabs?.length ? dashboard.slabs : structuredClone(DEFAULT_SLABS);
    history = dashboard.history || [];
    document.getElementById("lastbill").value = dashboard.lastBill ?? "";
    render();
    renderHistory();
  } catch (error) {
    if (error instanceof TypeError) setSaveStatus("Start Wattwise with npm start", true);
  }
}

document.getElementById("presets").innerHTML = Object.keys(PRESETS).map((name) => `<option value="${esc(name)}">`).join("");
document.getElementById("name").addEventListener("input", (event) => {
  if (PRESETS[event.target.value]) document.getElementById("watts").value = PRESETS[event.target.value];
});
document.getElementById("lastbill").addEventListener("input", () => { render(); scheduleSync(); });
document.getElementById("logout-button").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } finally { window.location.assign("login.html"); }
});
document.getElementById("save-estimate").addEventListener("click", saveEstimate);

function addAppliance() {
  const name = document.getElementById("name").value.trim();
  const watts = Number(document.getElementById("watts").value);
  const hoursValue = document.getElementById("hours").value;
  const hours = Number(hoursValue);
  const qty = Number(document.getElementById("qty").value) || 1;
  if (!name || !Number.isFinite(watts) || watts <= 0 || hoursValue === "" || !Number.isFinite(hours) || hours < 0 || hours > 24 || !Number.isInteger(qty) || qty < 1) {
    alert("Enter an appliance, a positive watt value, daily hours from 0 to 24, and a whole-number quantity.");
    return;
  }
  appliances.push({ name, watts, hours, qty });
  ["name", "watts", "hours"].forEach((id) => { document.getElementById(id).value = ""; });
  document.getElementById("qty").value = 1;
  render();
  scheduleSync();
}

function delAppliance(index) { appliances.splice(index, 1); render(); scheduleSync(); }
function monthlyUnits(appliance) { return appliance.watts * appliance.hours * appliance.qty * 30 / 1000; }

function addSlab() {
  const last = slabs[slabs.length - 1];
  if (last.upto === null || last.upto === "") last.upto = (slabs.length > 1 ? Number(slabs[slabs.length - 2].upto) : 0) + 100;
  slabs.push({ upto: null, rate: Number(last.rate) + 2 });
  render();
  scheduleSync();
}
function resetSlabs() { slabs = structuredClone(DEFAULT_SLABS); render(); scheduleSync(); }
function updateSlab(index, field, value) {
  slabs[index][field] = value === "" ? (field === "upto" ? null : "") : Number(value);
  render(false);
  scheduleSync();
}

function calcBill(units) {
  let bill = 0;
  let previous = 0;
  for (const slab of slabs) {
    const cap = slab.upto === null || slab.upto === "" ? Infinity : Number(slab.upto);
    const rate = Number(slab.rate) || 0;
    if (units > previous && cap >= previous) bill += (Math.min(units, cap) - previous) * rate;
    previous = cap;
    if (units <= cap) break;
  }
  return bill;
}
function fmt(value) { return "₹" + Math.round(value).toLocaleString("en-IN"); }

function renderSlabs() {
  document.getElementById("slabs").innerHTML = slabs.map((slab, index) => {
    const from = index === 0 ? 0 : slabs[index - 1].upto;
    return `<div class="slab">
      <input type="number" min="0" placeholder="Up to units (${from ?? "above"})" value="${slab.upto ?? ""}" onchange="updateSlab(${index},'upto',this.value)">
      <input type="number" min="0" step="0.1" placeholder="₹ per unit" value="${slab.rate}" onchange="updateSlab(${index},'rate',this.value)">
    </div>`;
  }).join("");
}

function calcOnly() { render(false); }
function render(rebuildSlabs = true) {
  document.getElementById("list").innerHTML = appliances.map((appliance, index) =>
    `<tr><td>${esc(appliance.name)}</td><td>${Number(appliance.watts)}</td><td>${Number(appliance.hours)}</td><td>${Number(appliance.qty)}</td><td>${monthlyUnits(appliance).toFixed(1)}</td><td><button class="del" aria-label="Remove ${esc(appliance.name)}" onclick="delAppliance(${index})">✕</button></td></tr>`
  ).join("") || `<tr><td colspan="6" class="muted">No appliances yet. Add one above.</td></tr>`;
  if (rebuildSlabs) renderSlabs();

  const units = appliances.reduce((sum, appliance) => sum + monthlyUnits(appliance), 0);
  const bill = calcBill(units);
  document.getElementById("units").textContent = units.toFixed(1);
  document.getElementById("bill").textContent = fmt(bill);
  document.getElementById("perday").textContent = fmt(bill / 30);

  const lastBill = Number(document.getElementById("lastbill").value);
  const comparison = document.getElementById("compare");
  if (lastBill > 0 && units > 0) {
    const difference = bill - lastBill;
    const percent = Math.abs(difference / lastBill * 100).toFixed(1);
    comparison.innerHTML = difference > 0
      ? `Predicted bill is <b>${fmt(difference)} (${percent}%) higher</b> than last month.`
      : `Predicted bill is <b>${fmt(-difference)} (${percent}%) lower</b> than last month.`;
  } else comparison.textContent = "Add your last bill to see a comparison.";

  const sorted = [...appliances].sort((a, b) => monthlyUnits(b) - monthlyUnits(a));
  const max = sorted.length ? monthlyUnits(sorted[0]) : 1;
  document.getElementById("chart").innerHTML = sorted.map((appliance) => {
    const unitsUsed = monthlyUnits(appliance);
    return `<div class="bar-row"><div class="bar-label">${esc(appliance.name)}</div><div class="bar" style="width:${unitsUsed / max * 100}%"></div><span>${unitsUsed.toFixed(1)} u</span></div>`;
  }).join("") || `<p class="muted">Add appliances to see the chart.</p>`;
  renderTips(sorted, bill);
}

function renderTips(sorted, bill) {
  const target = document.getElementById("tips-content");
  if (!sorted.length) { target.innerHTML = `<p class="muted">Tips will appear here.</p>`; return; }
  const tips = [`<b>${esc(sorted[0].name)}</b> is your biggest consumer (${monthlyUnits(sorted[0]).toFixed(1)} units/month).`];
  sorted.slice(0, 3).forEach((appliance) => {
    if (appliance.hours < 1) return;
    const reducedUnits = appliances.reduce((sum, item) => sum + monthlyUnits(item) - (item === appliance ? appliance.watts * appliance.qty / 1000 * 30 : 0), 0);
    const saving = Math.max(0, bill - calcBill(reducedUnits));
    tips.push(`Use <b>${esc(appliance.name)}</b> 1 hour less per day and save about <b>${fmt(saving)}</b> per month.`);
  });
  const highWattBulb = appliances.find((appliance) => /bulb/i.test(appliance.name) && appliance.watts > 15);
  if (highWattBulb) tips.push(`Switch “${esc(highWattBulb.name)}” to a 9W LED to reduce its power use.`);
  if (appliances.some((appliance) => /\bAC\b|air conditioner/i.test(appliance.name))) tips.push("Set the AC to 24–26°C and keep filters clean to help reduce energy use.");
  tips.push("Unplug chargers and turn off standby devices when they are not in use.");
  target.innerHTML = tips.map((tip) => `<div class="tip">${tip}</div>`).join("");
}

function renderHistory() {
  const target = document.getElementById("history-list");
  if (!history.length) {
    target.innerHTML = `<p class="history-empty">No saved estimates yet. Save this month’s estimate to start tracking your progress.</p>`;
    return;
  }
  target.innerHTML = history.map((item) => {
    const [year, month] = item.month.split("-").map(Number);
    const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
    return `<article class="history-item"><div class="history-month">${esc(monthName)}</div><div class="history-values"><span><b>${Number(item.units).toFixed(1)}</b> kWh</span><span><b>${fmt(Number(item.bill))}</b></span></div></article>`;
  }).join("");
}

async function saveEstimate() {
  const button = document.getElementById("save-estimate");
  const units = appliances.reduce((sum, appliance) => sum + monthlyUnits(appliance), 0);
  const bill = calcBill(units);
  button.disabled = true;
  setSaveStatus("Saving estimate…");
  try {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const result = await api("/api/history", { method: "POST", body: JSON.stringify({ month, units, bill }) });
    history = result.history;
    renderHistory();
    setSaveStatus("Estimate saved");
  } catch (error) { setSaveStatus(error.message, true); }
  finally { button.disabled = false; }
}

function scheduleSync() {
  setSaveStatus("Changes pending…");
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncDashboard, 500);
}
async function syncDashboard() {
  if (syncing) { syncTimer = setTimeout(syncDashboard, 300); return; }
  syncing = true;
  setSaveStatus("Saving changes…");
  try {
    await api("/api/appliances", { method: "PUT", body: JSON.stringify({ appliances }) });
    await api("/api/rates", { method: "PUT", body: JSON.stringify({ slabs }) });
    const lastBillValue = document.getElementById("lastbill").value;
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ lastBill: lastBillValue }) });
    setSaveStatus("Saved to your account");
  } catch (error) { setSaveStatus(error.message, true); }
  finally { syncing = false; }
}
function setSaveStatus(text, isError = false) {
  const label = document.querySelector(".local-badge .save-label");
  if (label) label.textContent = text;
  const badge = document.querySelector(".local-badge");
  if (badge) badge.classList.toggle("save-error", isError);
}
function esc(value) { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }

initialize();

import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import {
  LayoutDashboard, Users, PhoneCall, Package, Boxes, Plus, X, Phone,
  MapPin, Search, ChevronRight, AlertTriangle, CheckCircle2, XCircle,
  Truck, RotateCcw, Loader2, Save, Hash, PackageX, Wallet, DollarSign,
  Upload, FileSpreadsheet, CloudUpload, Menu, MoreHorizontal, LogOut, Lock,
} from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

/* ---------------------------------------------------------------
   COD OS — Algeria — connected to Supabase
   Real backend: PostgreSQL + Auth + RLS, multi-user, ~6s sync refresh

   Note: this build talks to Supabase over plain fetch() against its
   REST (PostgREST) and Auth HTTP endpoints — both support browser CORS
   by design. It does not use the supabase-js SDK (not in this sandbox's
   verified library set), so updates sync via short polling rather than
   the SDK's websocket realtime channel. Swapping in supabase-js for
   true push updates is a drop-in change outside this sandbox.
---------------------------------------------------------------- */

const SUPABASE_URL = "https://pghmcsxpuvfbldkwywad.supabase.co";
const SUPABASE_KEY = "sb_publishable_pkqHRnaAis46pmcymQgVBg_oji4zmh0";
const POLL_MS = 6000;

const WILAYAS = [
  "Adrar","Chlef","Laghouat","Oum El Bouaghi","Batna","Béjaïa","Biskra","Béchar",
  "Blida","Bouira","Tamanrasset","Tébessa","Tlemcen","Tiaret","Tizi Ouzou","Alger",
  "Djelfa","Jijel","Sétif","Saïda","Skikda","Sidi Bel Abbès","Annaba","Guelma",
  "Constantine","Médéa","Mostaganem","M'Sila","Mascara","Ouargla","Oran","El Bayadh",
  "Illizi","Bordj Bou Arréridj","Boumerdès","El Tarf","Tindouf","Tissemsilt","El Oued",
  "Khenchela","Souk Ahras","Tipaza","Mila","Aïn Defla","Naâma","Aïn Témouchent",
  "Ghardaïa","Relizane"
];

const STATUS_FLOW = {
  "New Lead": { next: ["Waiting Call"], color: "#8B92A6" },
  "Waiting Call": { next: ["No Answer","Busy","Call Back","Wrong Number","Interested","Confirmed","Cancelled"], color: "#F0B429" },
  "No Answer": { next: ["Waiting Call","Cancelled"], color: "#F0B429" },
  "Busy": { next: ["Waiting Call","Cancelled"], color: "#F0B429" },
  "Call Back": { next: ["Waiting Call","Cancelled"], color: "#F0B429" },
  "Wrong Number": { next: [], color: "#EF4444" },
  "Interested": { next: ["Confirmed","Cancelled"], color: "#3B82F6" },
  "Confirmed": { next: ["Ready For Shipping","Cancelled"], color: "#10B981" },
  "Cancelled": { next: [], color: "#EF4444" },
  "Fake": { next: [], color: "#EF4444" },
  "Duplicate": { next: [], color: "#EF4444" },
  "Blacklisted": { next: [], color: "#EF4444" },
  "Ready For Shipping": { next: ["Shipped"], color: "#0EA5E9" },
  "Shipped": { next: ["In Transit"], color: "#0EA5E9" },
  "In Transit": { next: ["Delivered","Returned"], color: "#0EA5E9" },
  "Delivered": { next: ["Refunded"], color: "#10B981" },
  "Returned": { next: ["Refunded"], color: "#EF4444" },
  "Refunded": { next: [], color: "#8B92A6" },
};

const QUEUE_STATUSES = ["New Lead","Waiting Call","No Answer","Busy","Call Back","Interested"];
const ORDER_STATUSES = ["Confirmed","Ready For Shipping","Shipped","In Transit"];
const DELIVERY_COMPANIES = ["Yalidine","ZR Express","Maystro Delivery","ECOTRACK","Anderson","NOEST Express","Guepex","World Express","Autre"];
const RETURN_REASONS = ["Client absent / injoignable","Client a refusé le colis","Adresse incorrecte","Changement d'avis","Produit endommagé au transport","Retard de livraison","Doublon","Autre"];
const EXPENSE_CATEGORIES = ["Ad Spend","Delivery Fees","Packaging","Salary","Software","Other"];
const PERIODS = [{ id: "today", label: "Today" }, { id: "week", label: "Week" }, { id: "month", label: "Month" }, { id: "all", label: "All" }];

const uid = () => Math.random().toString(36).slice(2, 10);
const dz = (n) => new Intl.NumberFormat("fr-DZ").format(Math.round(n || 0)) + " DA";
const cx = (...a) => a.filter(Boolean).join(" ");

function withinPeriod(dateStr, period) {
  const d = new Date(dateStr);
  const now = new Date();
  if (period === "all") return true;
  if (period === "today") return d.toDateString() === now.toDateString();
  if (period === "week") { const s = new Date(now); s.setDate(now.getDate() - now.getDay()); s.setHours(0,0,0,0); return d >= s; }
  if (period === "month") return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  return true;
}

/* ---------------- Supabase REST helpers ---------------- */
const LEAD_KEY_MAP = { phone2: "phone2", shippingCost: "shipping_cost", deliveryCompany: "delivery_company", trackingNumber: "tracking_number", pickupDate: "pickup_date", deliveryAttempts: "delivery_attempts", codCollected: "cod_collected", returnReason: "return_reason", returnCondition: "return_condition", shopifyOrderId: "shopify_order_id" };
const toLeadDb = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) out[LEAD_KEY_MAP[k] || k] = v; return out; };
const fromLeadDb = (r) => ({
  id: r.id, name: r.name, phone: r.phone, phone2: r.phone2 || "", wilaya: r.wilaya || "", commune: r.commune || "",
  address: r.address || "", product: r.product, qty: r.qty, price: Number(r.price), shippingCost: Number(r.shipping_cost),
  total: Number(r.total), source: r.source, status: r.status, notes: r.notes || "",
  deliveryCompany: r.delivery_company, trackingNumber: r.tracking_number, pickupDate: r.pickup_date,
  deliveryAttempts: r.delivery_attempts || 0, codCollected: r.cod_collected != null ? Number(r.cod_collected) : null,
  returnReason: r.return_reason, returnCondition: r.return_condition, shopifyOrderId: r.shopify_order_id,
  createdAt: r.created_at,
});
const toInvDb = (o) => { const out = { ...o }; if ("purchasePrice" in out) { out.purchase_price = out.purchasePrice; delete out.purchasePrice; } if ("sellPrice" in out) { out.sell_price = out.sellPrice; delete out.sellPrice; } return out; };
const fromInvDb = (r) => ({ id: r.id, name: r.name, sku: r.sku || "", stock: r.stock, reserved: r.reserved || 0, purchasePrice: Number(r.purchase_price), sellPrice: Number(r.sell_price) });
const fromExpDb = (r) => ({ id: r.id, date: r.date, category: r.category, amount: Number(r.amount), note: r.note || "", createdAt: r.created_at });

function useSupabaseSession() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [authReady, setAuthReady] = useState(false);

  const rest = useCallback(async (path, opts = {}, token) => {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token || session?.access_token || SUPABASE_KEY}`,
        "Content-Type": "application/json",
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      let msg = res.statusText;
      try { const j = await res.json(); msg = j.error_description || j.message || j.msg || msg; } catch {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }, [session]);

  const loadProfile = useCallback(async (token, userId) => {
    const rows = await rest(`/rest/v1/profiles?id=eq.${userId}&select=id,full_name,role`, {}, token);
    return rows?.[0] || null;
  }, [rest]);

  useEffect(() => {
    (async () => {
      try {
        const stored = await window.storage.get("session");
        if (stored) {
          const s = JSON.parse(stored.value);
          const p = await loadProfile(s.access_token, s.user.id);
          setSession(s); setProfile(p);
        }
      } catch {}
      setAuthReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = async (email, password) => {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || "Login failed");
    const p = await loadProfile(data.access_token, data.user.id);
    setSession(data); setProfile(p);
    try { await window.storage.set("session", JSON.stringify(data)); } catch {}
    return p;
  };

  const logout = async () => {
    setSession(null); setProfile(null);
    try { await window.storage.delete("session"); } catch {}
  };

  return { session, profile, authReady, login, logout, rest };
}

function useSupabaseData(session, rest) {
  const [leads, setLeadsState] = useState([]);
  const [inventory, setInventoryState] = useState([]);
  const [expenses, setExpensesState] = useState([]);
  const [history, setHistory] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchAll = useCallback(async () => {
    try {
      const [l, inv, exp, hist] = await Promise.all([
        rest(`/rest/v1/leads?select=*&order=created_at.desc`),
        rest(`/rest/v1/inventory?select=*&order=name.asc`),
        rest(`/rest/v1/expenses?select=*&order=date.desc`),
        rest(`/rest/v1/lead_status_history?select=lead_id,status,at&order=at.asc`),
      ]);
      setLeadsState(l.map(fromLeadDb));
      setInventoryState(inv.map(fromInvDb));
      setExpensesState(exp.map(fromExpDb));
      const h = {};
      hist.forEach(row => { (h[row.lead_id] ||= []).push({ status: row.status, at: row.at }); });
      setHistory(h);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [rest]);

  useEffect(() => {
    if (!session) return;
    fetchAll();
    const t = setInterval(fetchAll, POLL_MS);
    return () => clearInterval(t);
  }, [session, fetchAll]);

  const addLead = async (lead) => {
    const { id, statusHistory, ...body } = lead;
    const rows = await rest(`/rest/v1/leads`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(toLeadDb(body)) });
    setLeadsState(prev => [fromLeadDb(rows[0]), ...prev]);
  };

  const updateLead = async (updated) => {
    const { id, statusHistory, ...body } = updated;
    const rows = await rest(`/rest/v1/leads?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(toLeadDb(body)) });
    setLeadsState(prev => prev.map(l => l.id === id ? fromLeadDb(rows[0]) : l));
    fetchAll();
  };

  const importLeads = async (newLeads) => {
    const bodies = newLeads.map(({ id, statusHistory, ...b }) => toLeadDb(b));
    const rows = await rest(`/rest/v1/leads`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(bodies) });
    setLeadsState(prev => [...rows.map(fromLeadDb), ...prev]);
  };

  const addInventoryItem = async (item) => {
    const { id, ...body } = item;
    const rows = await rest(`/rest/v1/inventory`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(toInvDb(body)) });
    setInventoryState(prev => [...prev, fromInvDb(rows[0])]);
  };

  const updateInventoryItem = async (id, patch) => {
    const rows = await rest(`/rest/v1/inventory?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(toInvDb(patch)) });
    setInventoryState(prev => prev.map(i => i.id === id ? fromInvDb(rows[0]) : i));
  };

  const addExpense = async (expense) => {
    const { id, createdAt, ...body } = expense;
    const rows = await rest(`/rest/v1/expenses`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(body) });
    setExpensesState(prev => [fromExpDb(rows[0]), ...prev]);
  };

  return { leads, inventory, expenses, history, loading, error, addLead, updateLead, importLeads, addInventoryItem, updateInventoryItem, addExpense, refresh: fetchAll };
}

/* ---------------- Responsive + UI primitives ---------------- */
function useBreakpoint() {
  const [w, setW] = useState(typeof window !== "undefined" ? window.innerWidth : 1280);
  useEffect(() => { const onR = () => setW(window.innerWidth); window.addEventListener("resize", onR); return () => window.removeEventListener("resize", onR); }, []);
  return { isDesktop: w >= 1024 };
}

function GlobalStyles() {
  return <style>{`
    @keyframes fadeSlideIn { from { opacity:0; transform: translateY(8px);} to {opacity:1; transform:translateY(0);} }
    .tab-enter { animation: fadeSlideIn .22s cubic-bezier(0.16,1,0.3,1); }
    * { -webkit-tap-highlight-color: transparent; }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 8px; }
  `}</style>;
}

function Modal({ onClose, title, subtitle, children, maxWidth = "sm:max-w-md" }) {
  const [show, setShow] = useState(false);
  useEffect(() => { const r = requestAnimationFrame(() => setShow(true)); return () => cancelAnimationFrame(r); }, []);
  const close = () => { setShow(false); setTimeout(onClose, 180); };
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center transition-colors duration-200"
      style={{ backgroundColor: show ? "rgba(0,0,0,0.6)" : "rgba(0,0,0,0)" }}
      onClick={close}
    >
      <div onClick={(e) => e.stopPropagation()}
        className={cx("w-full", maxWidth, "bg-neutral-900 border border-neutral-800 rounded-t-2xl sm:rounded-2xl max-h-screen overflow-y-auto p-5 transition-all duration-200 ease-out", show ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0")}
        style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center justify-between mb-4 sticky top-0 bg-neutral-900">
          <div><h3 className="text-white font-medium text-base">{title}</h3>{subtitle && <p className="text-neutral-500 text-xs mt-0.5">{subtitle}</p>}</div>
          <button onClick={close} className="text-neutral-500 hover:text-white p-1.5 -m-1.5 rounded-lg hover:bg-neutral-800 shrink-0"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }) { return <div>{label && <div className="text-neutral-500 text-xs mb-1.5">{label}</div>}{children}</div>; }
const inputCls = "w-full bg-black border border-neutral-800 rounded-lg px-3 py-2.5 sm:py-2 text-sm text-white placeholder-neutral-600 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-400 transition-colors";

function Button({ children, variant = "primary", className, ...props }) {
  const variants = { primary: "bg-amber-500 hover:bg-amber-400 active:bg-amber-500 text-black font-medium", ghost: "bg-neutral-800 hover:bg-neutral-700 text-neutral-200 border border-neutral-800", danger: "bg-red-900 hover:bg-red-800 text-red-400 border border-red-700" };
  return <button className={cx("rounded-lg text-sm py-2.5 px-4 transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2", variants[variant], className)} {...props}>{children}</button>;
}

function StatusPill({ status }) {
  const c = STATUS_FLOW[status]?.color || "#8B92A6";
  return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap" style={{ backgroundColor: c + "1a", color: c, border: `1px solid ${c}33` }}><span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: c }} />{status}</span>;
}

function Card({ children, className }) { return <div className={cx("rounded-xl border border-neutral-800 bg-neutral-900", className)}>{children}</div>; }
function EmptyState({ icon: Icon, title, subtitle }) { return <Card className="p-10 sm:p-12 text-center"><Icon className="mx-auto text-neutral-700 mb-3" size={28} /><div className="text-white font-medium">{title}</div>{subtitle && <div className="text-neutral-500 text-sm mt-1">{subtitle}</div>}</Card>; }

/* ---------------- Login ---------------- */
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!email.trim() || !password.trim() || busy) return;
    setErr(null); setBusy(true);
    try { await onLogin(email, password); }
    catch (ex) { setErr(ex.message); }
    finally { setBusy(false); }
  };

  const onKeyDown = (e) => { if (e.key === "Enter") submit(); };

  return (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-4" style={{ fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <GlobalStyles />
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-11 h-11 rounded-xl bg-amber-900 border border-amber-700 flex items-center justify-center mx-auto mb-3"><Lock size={18} className="text-amber-400" /></div>
          <div className="text-lg font-semibold">COD Operating System</div>
          <div className="text-neutral-500 text-xs mt-1">Sign in to your workspace</div>
        </div>
        <div className="space-y-3">
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={onKeyDown} className={inputCls} autoComplete="username" />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={onKeyDown} className={inputCls} autoComplete="current-password" />
          {err && <div className="text-red-400 text-xs px-1">{err}</div>}
          <Button onClick={submit} disabled={busy || !email.trim() || !password.trim()} className="w-full">{busy ? <Loader2 size={15} className="animate-spin" /> : "Sign In"}</Button>
        </div>
        <div className="text-neutral-600 text-xs text-center mt-6">Accounts are created by your Owner in Supabase. Contact them if you need access.</div>
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
function Dashboard({ leads, inventory }) {
  const stats = useMemo(() => {
    const today = new Date().toDateString();
    const todays = leads.filter(l => new Date(l.createdAt).toDateString() === today);
    const confirmed = leads.filter(l => ["Confirmed","Ready For Shipping","Shipped","In Transit","Delivered"].includes(l.status));
    const delivered = leads.filter(l => l.status === "Delivered");
    const cancelled = leads.filter(l => ["Cancelled","Fake","Wrong Number"].includes(l.status));
    const returned = leads.filter(l => l.status === "Returned");
    const pendingQueue = leads.filter(l => QUEUE_STATUSES.includes(l.status));
    const totalReachable = leads.filter(l => l.status !== "New Lead").length || 1;
    const confRate = (confirmed.length / totalReachable) * 100;
    const shippedOrReturned = leads.filter(l => ["Shipped","In Transit","Delivered","Returned"].includes(l.status)).length || 1;
    const delRate = (delivered.length / shippedOrReturned) * 100;
    const profitToday = todays.filter(l => l.status === "Delivered").reduce((s, l) => { const inv = inventory.find(i => i.name === l.product); return s + ((l.total || 0) - (inv ? inv.purchasePrice : 0) - (l.shippingCost || 0)); }, 0);
    const lowStock = inventory.filter(i => (i.stock - i.reserved) <= 20);
    const codCollected = delivered.reduce((s, l) => s + (l.codCollected || l.total || 0), 0);
    const inTransit = leads.filter(l => ["Ready For Shipping","Shipped","In Transit"].includes(l.status));
    return { todays, confirmed, delivered, cancelled, returned, pendingQueue, confRate, delRate, profitToday, lowStock, codCollected, inTransit };
  }, [leads, inventory]);

  const cards = [
    { label: "New Leads Today", value: stats.todays.length, icon: Users, tone: "#8B92A6" },
    { label: "In Queue", value: stats.pendingQueue.length, icon: PhoneCall, tone: "#F0B429" },
    { label: "Confirmed", value: stats.confirmed.length, icon: CheckCircle2, tone: "#10B981" },
    { label: "Delivered", value: stats.delivered.length, icon: Truck, tone: "#0EA5E9" },
    { label: "Cancelled", value: stats.cancelled.length, icon: XCircle, tone: "#EF4444" },
    { label: "Returned", value: stats.returned.length, icon: RotateCcw, tone: "#EF4444" },
  ];

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-3">
        {cards.map((c) => <Card key={c.label} className="p-3.5 sm:p-4"><c.icon size={16} style={{ color: c.tone }} className="mb-2" /><div className="text-xl sm:text-2xl font-semibold text-white tabular-nums">{c.value}</div><div className="text-xs sm:text-xs text-neutral-400 mt-0.5">{c.label}</div></Card>)}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-3">
        <Card className="p-4"><div className="text-xs text-neutral-400 mb-1">Confirmation Rate</div><div className="text-xl sm:text-2xl font-semibold text-white">{stats.confRate.toFixed(1)}%</div></Card>
        <Card className="p-4"><div className="text-xs text-neutral-400 mb-1">Delivery Rate</div><div className="text-xl sm:text-2xl font-semibold text-white">{stats.delRate.toFixed(1)}%</div></Card>
        <Card className="p-4"><div className="text-xs text-neutral-400 mb-1">Profit Today</div><div className="text-xl sm:text-2xl font-semibold" style={{ color: stats.profitToday >= 0 ? "#10B981" : "#EF4444" }}>{dz(stats.profitToday)}</div></Card>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
        <Card className="p-4 flex items-center gap-3"><Wallet size={18} className="text-emerald-400 shrink-0" /><div><div className="text-xs text-neutral-400">COD Collected (all time)</div><div className="text-base sm:text-lg font-semibold text-white">{dz(stats.codCollected)}</div></div></Card>
        <Card className="p-4 flex items-center gap-3"><Truck size={18} className="text-sky-400 shrink-0" /><div><div className="text-xs text-neutral-400">Currently In Transit</div><div className="text-base sm:text-lg font-semibold text-white">{stats.inTransit.length} orders</div></div></Card>
      </div>
      {stats.lowStock.length > 0 && (
        <div className="rounded-xl border border-amber-700 bg-amber-900 p-4 flex items-start gap-3">
          <AlertTriangle size={18} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="text-sm text-amber-200"><span className="font-medium">Low stock — </span>{stats.lowStock.map(i => `${i.name} (${i.stock - i.reserved} left)`).join(", ")}</div>
        </div>
      )}
      <Card className="p-4">
        <div className="text-sm font-medium text-white mb-3">Recent Activity</div>
        <div className="space-y-2">
          {[...leads].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 8).map(l => (
            <div key={l.id} className="flex items-center justify-between text-sm py-1.5 border-b border-neutral-800 last:border-0 gap-2">
              <div className="text-neutral-200 truncate">{l.name} <span className="text-neutral-500">· {l.product}</span></div>
              <StatusPill status={l.status} />
            </div>
          ))}
          {leads.length === 0 && <div className="text-neutral-500 text-sm">No leads yet.</div>}
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Lead Form ---------------- */
function LeadForm({ onSave, onClose, inventory }) {
  const [form, setForm] = useState({ name: "", phone: "", phone2: "", wilaya: WILAYAS[0], commune: "", address: "", product: inventory[0]?.name || "", qty: 1, price: inventory[0]?.sellPrice || 0, shippingCost: 500, source: "Facebook", notes: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const total = (Number(form.price) * Number(form.qty || 1)) + Number(form.shippingCost || 0);

  const submit = async () => {
    if (!form.name.trim() || !form.phone.trim()) return;
    setSaving(true); setErr(null);
    try {
      await onSave({ ...form, qty: Number(form.qty) || 1, price: Number(form.price) || 0, shippingCost: Number(form.shippingCost) || 0, total, status: "New Lead" });
      onClose();
    } catch (ex) {
      setErr(ex.message || "Failed to save lead");
    } finally { setSaving(false); }
  };

  return (
    <Modal title="New Lead" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2"><input placeholder="Full name" value={form.name} onChange={e => set("name", e.target.value)} className={inputCls} /></div>
          <input placeholder="Phone" inputMode="tel" value={form.phone} onChange={e => set("phone", e.target.value)} className={inputCls} />
          <input placeholder="Second phone" inputMode="tel" value={form.phone2} onChange={e => set("phone2", e.target.value)} className={inputCls} />
          <select value={form.wilaya} onChange={e => set("wilaya", e.target.value)} className={inputCls}>{WILAYAS.map(w => <option key={w} value={w}>{w}</option>)}</select>
          <input placeholder="Commune" value={form.commune} onChange={e => set("commune", e.target.value)} className={inputCls} />
          <div className="col-span-2"><input placeholder="Address" value={form.address} onChange={e => set("address", e.target.value)} className={inputCls} /></div>
          <select value={form.product} onChange={e => { const p = inventory.find(i => i.name === e.target.value); set("product", e.target.value); if (p) set("price", p.sellPrice); }} className={cx(inputCls, "col-span-2")}>{inventory.map(i => <option key={i.id} value={i.name}>{i.name}</option>)}</select>
          <input type="number" inputMode="numeric" placeholder="Qty" value={form.qty} onChange={e => set("qty", e.target.value)} className={inputCls} />
          <input type="number" inputMode="numeric" placeholder="Price (DA)" value={form.price} onChange={e => set("price", e.target.value)} className={inputCls} />
          <input type="number" inputMode="numeric" placeholder="Shipping cost" value={form.shippingCost} onChange={e => set("shippingCost", e.target.value)} className={inputCls} />
          <select value={form.source} onChange={e => set("source", e.target.value)} className={inputCls}>{["Facebook","TikTok","Instagram","Google Sheets Import","Manual","Other"].map(s => <option key={s}>{s}</option>)}</select>
          <div className="col-span-2"><textarea placeholder="Notes" value={form.notes} onChange={e => set("notes", e.target.value)} className={cx(inputCls, "resize-none h-16")} /></div>
        </div>
        <div className="flex items-center justify-between pt-1 text-sm text-neutral-400"><span>Order total</span><span className="text-white font-medium">{dz(total)}</span></div>
        {err && <div className="text-red-400 text-xs px-1">{err}</div>}
        <Button onClick={submit} disabled={!form.name.trim() || !form.phone.trim() || saving} className="w-full">{saving ? <Loader2 size={15} className="animate-spin" /> : <><Save size={15} /> Save Lead</>}</Button>
      </div>
    </Modal>
  );
}

/* ---------------- Leads Table ---------------- */
function LeadsTable({ leads, onOpen, filterStatuses }) {
  const [q, setQ] = useState("");
  const rows = leads.filter(l => !filterStatuses || filterStatuses.includes(l.status)).filter(l => !q || l.name.toLowerCase().includes(q.toLowerCase()) || l.phone.includes(q)).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  return (
    <div>
      <div className="relative mb-3"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-600" /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or phone..." className={cx(inputCls, "pl-8")} /></div>
      {rows.length === 0 && <EmptyState icon={Users} title="No leads match" />}
      {rows.length > 0 && (
        <>
          <div className="hidden md:block rounded-xl border border-neutral-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="bg-neutral-900 text-neutral-500 text-xs uppercase tracking-wide"><th className="text-left px-4 py-2.5 font-medium">Customer</th><th className="text-left px-4 py-2.5 font-medium">Wilaya</th><th className="text-left px-4 py-2.5 font-medium">Product</th><th className="text-left px-4 py-2.5 font-medium">Total</th><th className="text-left px-4 py-2.5 font-medium">Status</th><th className="w-8"></th></tr></thead>
              <tbody>
                {rows.map(l => (
                  <tr key={l.id} onClick={() => onOpen(l)} className="border-t border-neutral-800 hover:bg-neutral-900 cursor-pointer">
                    <td className="px-4 py-2.5"><div className="text-white">{l.name}</div><div className="text-neutral-500 text-xs flex items-center gap-1"><Phone size={10} />{l.phone}</div></td>
                    <td className="px-4 py-2.5 text-neutral-300"><div className="flex items-center gap-1"><MapPin size={11} className="text-neutral-600" />{l.wilaya}</div></td>
                    <td className="px-4 py-2.5 text-neutral-300">{l.product} <span className="text-neutral-500">×{l.qty}</span></td>
                    <td className="px-4 py-2.5 text-neutral-200 tabular-nums">{dz(l.total)}</td>
                    <td className="px-4 py-2.5"><StatusPill status={l.status} /></td>
                    <td className="px-4 py-2.5 text-neutral-700"><ChevronRight size={14} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="md:hidden space-y-2">
            {rows.map(l => (
              <button key={l.id} onClick={() => onOpen(l)} className="w-full text-left rounded-xl border border-neutral-800 bg-neutral-900 p-3.5 active:bg-neutral-800">
                <div className="flex items-start justify-between gap-2 mb-1.5"><div className="text-white font-medium text-sm">{l.name}</div><StatusPill status={l.status} /></div>
                <div className="text-neutral-500 text-xs flex items-center gap-1 mb-1"><Phone size={10} />{l.phone}</div>
                <div className="flex items-center justify-between text-xs text-neutral-400"><span className="flex items-center gap-1"><MapPin size={10} className="text-neutral-600" />{l.wilaya}</span><span className="text-neutral-200 tabular-nums">{dz(l.total)}</span></div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Lead Detail ---------------- */
function LeadDetail({ lead, history, onClose, onUpdate }) {
  const [notes, setNotes] = useState(lead.notes || "");
  const [busy, setBusy] = useState(false);
  const options = STATUS_FLOW[lead.status]?.next || [];
  const changeStatus = async (status) => { setBusy(true); try { await onUpdate({ ...lead, status, notes }); onClose(); } finally { setBusy(false); } };
  const saveNotes = () => onUpdate({ ...lead, notes });

  return (
    <Modal title={lead.name} subtitle={`${lead.phone}${lead.phone2 ? " · " + lead.phone2 : ""}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3 text-sm mb-4">
        <Field label="Wilaya"><div className="text-white">{lead.wilaya}{lead.commune ? `, ${lead.commune}` : ""}</div></Field>
        <Field label="Product"><div className="text-white">{lead.product} ×{lead.qty}</div></Field>
        <Field label="Total"><div className="text-white">{dz(lead.total)}</div></Field>
        <Field label="Source"><div className="text-white">{lead.source}</div></Field>
      </div>
      <div className="mb-4"><Field label="Current status"><StatusPill status={lead.status} /></Field></div>
      {options.length > 0 && (
        <div className="mb-4">
          <div className="text-neutral-500 text-xs mb-2">Move to</div>
          <div className="flex flex-wrap gap-2">{options.map(s => <button key={s} disabled={busy} onClick={() => changeStatus(s)} className="px-3 py-2 sm:py-1.5 rounded-lg text-xs border border-neutral-800 bg-neutral-800 hover:bg-neutral-700 active:bg-neutral-700 text-neutral-200 disabled:opacity-40">{s}</button>)}</div>
        </div>
      )}
      <div className="mb-4"><div className="text-neutral-500 text-xs mb-2">Notes</div><textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={saveNotes} className={cx(inputCls, "resize-none h-20")} /></div>
      <div>
        <div className="text-neutral-500 text-xs mb-2">History</div>
        <div className="space-y-1.5">
          {(history || []).slice().reverse().map((h, i) => <div key={i} className="flex items-center justify-between text-xs"><StatusPill status={h.status} /><span className="text-neutral-600">{new Date(h.at).toLocaleString("fr-DZ")}</span></div>)}
          {(!history || history.length === 0) && <div className="text-neutral-600 text-xs">No history yet.</div>}
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- Confirmation Queue ---------------- */
function ConfirmationQueue({ leads, onUpdate }) {
  const queue = leads.filter(l => QUEUE_STATUSES.includes(l.status)).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  const [idx, setIdx] = useState(0);
  const current = queue[Math.min(idx, queue.length - 1)];
  useEffect(() => { if (idx >= queue.length && queue.length > 0) setIdx(0); }, [queue.length, idx]);
  if (queue.length === 0) return <EmptyState icon={CheckCircle2} title="Queue clear" subtitle="Every lead has been called and moved forward." />;
  const act = (status) => onUpdate({ ...current, status });
  const quickActions = [{ label: "Confirmed", status: "Confirmed", color: "#10B981" }, { label: "No Answer", status: "No Answer", color: "#F0B429" }, { label: "Busy", status: "Busy", color: "#F0B429" }, { label: "Call Back", status: "Call Back", color: "#F0B429" }, { label: "Wrong Number", status: "Wrong Number", color: "#EF4444" }, { label: "Cancelled", status: "Cancelled", color: "#EF4444" }];
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-2 p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4"><div className="text-xs text-neutral-500">Lead {idx + 1} of {queue.length}</div><StatusPill status={current.status} /></div>
        <div className="text-lg sm:text-xl font-medium text-white mb-1">{current.name}</div>
        <div className="flex items-center gap-2 text-neutral-400 text-sm mb-4"><Phone size={13} /> {current.phone} {current.phone2 && <span className="text-neutral-600">· {current.phone2}</span>}</div>
        <div className="grid grid-cols-2 gap-3 text-sm mb-5">
          <Field label="Location"><div className="text-white">{current.wilaya}{current.commune ? `, ${current.commune}` : ""}</div></Field>
          <Field label="Address"><div className="text-white truncate">{current.address || "—"}</div></Field>
          <Field label="Product"><div className="text-white">{current.product} ×{current.qty}</div></Field>
          <Field label="Total"><div className="text-white">{dz(current.total)}</div></Field>
        </div>
        <div className="rounded-lg bg-black border border-neutral-800 p-3 mb-5 text-sm text-neutral-300"><span className="text-neutral-500">Script: </span>Bonjour {current.name.split(" ")[0]}, je vous appelle pour confirmer votre commande de {current.product} à {dz(current.total)}, livraison à {current.wilaya}. C'est bien noté ?</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">{quickActions.map(a => <button key={a.status} onClick={() => act(a.status)} className="rounded-lg py-3 sm:py-2.5 text-sm font-medium border active:scale-95 transition-transform" style={{ borderColor: a.color + "40", backgroundColor: a.color + "14", color: a.color }}>{a.label}</button>)}</div>
      </Card>
      <Card className="p-4 hidden lg:block">
        <div className="text-xs text-neutral-500 mb-3">Up next</div>
        <div className="space-y-1.5 max-h-96 overflow-y-auto">{queue.map((l, i) => <button key={l.id} onClick={() => setIdx(i)} className={cx("w-full text-left px-3 py-2 rounded-lg text-sm flex items-center justify-between", i === idx ? "bg-amber-900 border border-amber-700" : "hover:bg-neutral-800 border border-transparent")}><span className="text-neutral-200 truncate">{l.name}</span><StatusPill status={l.status} /></button>)}</div>
      </Card>
    </div>
  );
}

/* ---------------- Delivery ---------------- */
function DeliveryDetail({ lead, onClose, onUpdate }) {
  const [company, setCompany] = useState(lead.deliveryCompany || DELIVERY_COMPANIES[0]);
  const [tracking, setTracking] = useState(lead.trackingNumber || "");
  const [pickupDate, setPickupDate] = useState(lead.pickupDate || "");
  const attempts = lead.deliveryAttempts || 0;
  const persist = (patch) => onUpdate({ ...lead, ...patch });
  const saveDetails = () => persist({ deliveryCompany: company, trackingNumber: tracking, pickupDate });
  const move = async (status, extra = {}) => { await onUpdate({ ...lead, status, deliveryCompany: company, trackingNumber: tracking, pickupDate, ...extra }); onClose(); };
  const logAttempt = () => persist({ deliveryAttempts: attempts + 1 });
  return (
    <Modal title={lead.name} subtitle={`${lead.phone} · ${lead.wilaya}${lead.commune ? ", " + lead.commune : ""}`} onClose={onClose}>
      <div className="mb-4"><StatusPill status={lead.status} /></div>
      <div className="space-y-2.5 mb-4">
        <Field label="Delivery company"><select value={company} onChange={e => setCompany(e.target.value)} onBlur={saveDetails} className={inputCls}>{DELIVERY_COMPANIES.map(c => <option key={c}>{c}</option>)}</select></Field>
        <Field label="Tracking number"><input value={tracking} onChange={e => setTracking(e.target.value)} onBlur={saveDetails} placeholder="e.g. YAL-4021938" className={inputCls} /></Field>
        <Field label="Pickup date"><input type="date" value={pickupDate || ""} onChange={e => setPickupDate(e.target.value)} onBlur={saveDetails} className={inputCls} /></Field>
      </div>
      <div className="flex items-center justify-between mb-4 rounded-lg bg-black border border-neutral-800 px-3 py-2.5">
        <div className="text-sm text-neutral-400">Delivery attempts</div>
        <div className="flex items-center gap-2"><span className="text-white font-medium tabular-nums">{attempts}</span><button onClick={logAttempt} className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300">Log attempt</button></div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {lead.status === "Ready For Shipping" && <button onClick={() => move("Shipped")} className="col-span-2 rounded-lg py-2.5 text-sm font-medium bg-sky-900 border border-sky-700 text-sky-400">Mark Shipped</button>}
        {lead.status === "Shipped" && <button onClick={() => move("In Transit")} className="col-span-2 rounded-lg py-2.5 text-sm font-medium bg-sky-900 border border-sky-700 text-sky-400">Mark In Transit</button>}
        {lead.status === "In Transit" && <><button onClick={() => move("Delivered", { codCollected: lead.total })} className="rounded-lg py-2.5 text-sm font-medium bg-emerald-900 border border-emerald-700 text-emerald-400">Delivered · COD Collected</button><button onClick={() => move("Returned")} className="rounded-lg py-2.5 text-sm font-medium bg-red-900 border border-red-700 text-red-400">Returned</button></>}
      </div>
    </Modal>
  );
}

function DeliveryBoard({ leads, onUpdate }) {
  const [open, setOpen] = useState(null);
  const orders = leads.filter(l => ["Ready For Shipping","Shipped","In Transit"].includes(l.status)).sort((a,b) => new Date(a.createdAt) - new Date(b.createdAt));
  const columns = [{ status: "Ready For Shipping", label: "Ready" }, { status: "Shipped", label: "Shipped" }, { status: "In Transit", label: "In Transit" }];
  if (orders.length === 0) return <EmptyState icon={Truck} title="No orders in transit" subtitle='Confirmed orders move here once marked "Ready For Shipping".' />;
  return (
    <>
      <div className="grid sm:grid-cols-3 gap-3 sm:gap-4">
        {columns.map(col => {
          const items = orders.filter(l => l.status === col.status);
          return (
            <Card key={col.status} className="p-3">
              <div className="flex items-center justify-between px-1 mb-2"><span className="text-xs font-medium text-neutral-400">{col.label}</span><span className="text-xs text-neutral-500">{items.length}</span></div>
              <div className="space-y-2">
                {items.map(l => (
                  <button key={l.id} onClick={() => setOpen(l)} className="w-full text-left rounded-lg border border-neutral-800 bg-black p-3 hover:border-neutral-600 active:bg-neutral-800">
                    <div className="text-sm text-white">{l.name}</div><div className="text-xs text-neutral-500 mt-0.5">{l.wilaya}</div>
                    <div className="flex items-center justify-between mt-2"><span className="text-xs text-neutral-400 flex items-center gap-1">{l.trackingNumber ? <><Hash size={10} />{l.trackingNumber}</> : <span className="text-amber-500">No tracking #</span>}</span>{!!l.deliveryAttempts && <span className="text-xs text-neutral-600">{l.deliveryAttempts} attempt(s)</span>}</div>
                  </button>
                ))}
                {items.length === 0 && <div className="text-neutral-700 text-xs px-1 py-3">Empty</div>}
              </div>
            </Card>
          );
        })}
      </div>
      {open && <DeliveryDetail lead={leads.find(l => l.id === open.id) || open} onClose={() => setOpen(null)} onUpdate={onUpdate} />}
    </>
  );
}

/* ---------------- Returns ---------------- */
function ReturnDetail({ lead, onClose, onUpdate }) {
  const [reason, setReason] = useState(lead.returnReason || RETURN_REASONS[0]);
  const [condition, setCondition] = useState(lead.returnCondition || "Revendable");
  const save = () => onUpdate({ ...lead, returnReason: reason, returnCondition: condition });
  const refund = async () => { await onUpdate({ ...lead, returnReason: reason, returnCondition: condition, status: "Refunded" }); onClose(); };
  return (
    <Modal title={lead.name} subtitle={`${lead.product} ×${lead.qty} · ${dz(lead.total)}`} onClose={onClose}>
      <div className="mb-4"><StatusPill status={lead.status} /></div>
      <div className="space-y-2.5 mb-4">
        <Field label="Return reason"><select value={reason} onChange={e => setReason(e.target.value)} onBlur={save} className={inputCls}>{RETURN_REASONS.map(r => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Stock condition"><div className="flex gap-2">{["Revendable","Endommagé"].map(c => <button key={c} onClick={() => setCondition(c)} className={cx("flex-1 rounded-lg py-2.5 sm:py-2 text-xs border", condition === c ? "bg-amber-900 border-amber-600 text-amber-400" : "border-neutral-800 text-neutral-400")}>{c}</button>)}</div></Field>
      </div>
      {lead.status === "Returned" && <Button variant="ghost" onClick={refund} className="w-full">Mark Refunded / Closed</Button>}
    </Modal>
  );
}

function ReturnsBoard({ leads, onUpdate }) {
  const [open, setOpen] = useState(null);
  const items = leads.filter(l => ["Returned","Refunded","Cancelled"].includes(l.status)).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const reasonBreakdown = useMemo(() => { const map = {}; items.forEach(l => { if (l.returnReason) map[l.returnReason] = (map[l.returnReason] || 0) + 1; }); return Object.entries(map).sort((a,b) => b[1] - a[1]); }, [items]);
  if (items.length === 0) return <EmptyState icon={PackageX} title="No returns or cancellations" subtitle="This list fills up as orders come back or get cancelled." />;
  return (
    <div className="space-y-4">
      {reasonBreakdown.length > 0 && <Card className="p-4"><div className="text-xs text-neutral-500 mb-2.5">Return reasons</div><div className="flex flex-wrap gap-2">{reasonBreakdown.map(([r, n]) => <span key={r} className="text-xs px-2.5 py-1 rounded-full bg-neutral-800 border border-neutral-800 text-neutral-300">{r} <span className="text-neutral-500">×{n}</span></span>)}</div></Card>}
      <div className="hidden md:block rounded-xl border border-neutral-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="bg-neutral-900 text-neutral-500 text-xs uppercase tracking-wide"><th className="text-left px-4 py-2.5 font-medium">Customer</th><th className="text-left px-4 py-2.5 font-medium">Product</th><th className="text-left px-4 py-2.5 font-medium">Reason</th><th className="text-left px-4 py-2.5 font-medium">Status</th><th className="w-8"></th></tr></thead>
          <tbody>{items.map(l => <tr key={l.id} onClick={() => setOpen(l)} className="border-t border-neutral-800 hover:bg-neutral-900 cursor-pointer"><td className="px-4 py-2.5 text-white">{l.name}</td><td className="px-4 py-2.5 text-neutral-300">{l.product} ×{l.qty}</td><td className="px-4 py-2.5 text-neutral-400">{l.returnReason || "—"}</td><td className="px-4 py-2.5"><StatusPill status={l.status} /></td><td className="px-4 py-2.5 text-neutral-700"><ChevronRight size={14} /></td></tr>)}</tbody>
        </table>
      </div>
      <div className="md:hidden space-y-2">{items.map(l => <button key={l.id} onClick={() => setOpen(l)} className="w-full text-left rounded-xl border border-neutral-800 bg-neutral-900 p-3.5 active:bg-neutral-800"><div className="flex items-start justify-between gap-2 mb-1.5"><div className="text-white font-medium text-sm">{l.name}</div><StatusPill status={l.status} /></div><div className="text-neutral-400 text-xs">{l.product} ×{l.qty}</div>{l.returnReason && <div className="text-neutral-500 text-xs mt-1">{l.returnReason}</div>}</button>)}</div>
      {open && <ReturnDetail lead={leads.find(l => l.id === open.id) || open} onClose={() => setOpen(null)} onUpdate={onUpdate} />}
    </div>
  );
}

/* ---------------- Inventory ---------------- */
function Inventory({ inventory, canEdit, onAdd, onAdjust }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", sku: "", stock: 0, purchasePrice: 0, sellPrice: 0 });
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    try { await onAdd({ reserved: 0, ...form, stock: Number(form.stock), purchasePrice: Number(form.purchasePrice), sellPrice: Number(form.sellPrice) }); setForm({ name: "", sku: "", stock: 0, purchasePrice: 0, sellPrice: 0 }); setAdding(false); } finally { setSaving(false); }
  };
  return (
    <div>
      {canEdit && <div className="flex justify-end mb-3"><Button onClick={() => setAdding(true)} className="text-xs px-3 py-2"><Plus size={14} /> Add Product</Button></div>}
      <div className="hidden md:block rounded-xl border border-neutral-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="bg-neutral-900 text-neutral-500 text-xs uppercase tracking-wide"><th className="text-left px-4 py-2.5 font-medium">Product</th><th className="text-left px-4 py-2.5 font-medium">Stock</th><th className="text-left px-4 py-2.5 font-medium">Available</th><th className="text-left px-4 py-2.5 font-medium">Cost / Sell</th><th className="text-left px-4 py-2.5 font-medium">Margin</th><th className="text-left px-4 py-2.5 font-medium"></th></tr></thead>
          <tbody>
            {inventory.map(i => { const available = i.stock - i.reserved; const low = available <= 20; return (
              <tr key={i.id} className="border-t border-neutral-800">
                <td className="px-4 py-2.5"><div className="text-white">{i.name}</div><div className="text-neutral-500 text-xs">{i.sku}</div></td>
                <td className="px-4 py-2.5 text-neutral-300">{i.stock}</td>
                <td className="px-4 py-2.5"><span className={low ? "text-amber-400 font-medium" : "text-neutral-300"}>{available}</span>{low && <AlertTriangle size={12} className="inline ml-1 text-amber-400" />}</td>
                <td className="px-4 py-2.5 text-neutral-300">{dz(i.purchasePrice)} / {dz(i.sellPrice)}</td>
                <td className="px-4 py-2.5 text-emerald-400">{dz(i.sellPrice - i.purchasePrice)}</td>
                <td className="px-4 py-2.5">{canEdit && <div className="flex gap-1"><button onClick={() => onAdjust(i.id, i.stock + 10)} className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300">+10</button><button onClick={() => onAdjust(i.id, Math.max(0, i.stock - 10))} className="text-xs px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300">-10</button></div>}</td>
              </tr>
            );})}
          </tbody>
        </table>
      </div>
      <div className="md:hidden space-y-2">
        {inventory.map(i => { const available = i.stock - i.reserved; const low = available <= 20; return (
          <Card key={i.id} className="p-3.5">
            <div className="flex items-start justify-between mb-2"><div><div className="text-white font-medium text-sm">{i.name}</div><div className="text-neutral-500 text-xs">{i.sku}</div></div>{low && <AlertTriangle size={14} className="text-amber-400 shrink-0" />}</div>
            <div className="flex items-center justify-between text-xs text-neutral-400 mb-2"><span>Stock: <span className="text-white">{i.stock}</span></span><span>Available: <span className={low ? "text-amber-400" : "text-white"}>{available}</span></span><span className="text-emerald-400">+{dz(i.sellPrice - i.purchasePrice)}</span></div>
            {canEdit && <div className="flex gap-2"><button onClick={() => onAdjust(i.id, i.stock + 10)} className="flex-1 text-xs py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300">+10</button><button onClick={() => onAdjust(i.id, Math.max(0, i.stock - 10))} className="flex-1 text-xs py-2 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-300">-10</button></div>}
          </Card>
        );})}
      </div>
      {adding && (
        <Modal title="Add Product" onClose={() => setAdding(false)}>
          <div className="space-y-2.5">
            <input placeholder="Product name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className={inputCls} />
            <input placeholder="SKU" value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value }))} className={inputCls} />
            <input type="number" inputMode="numeric" placeholder="Starting stock" value={form.stock} onChange={e => setForm(f => ({ ...f, stock: e.target.value }))} className={inputCls} />
            <input type="number" inputMode="numeric" placeholder="Purchase price (DA)" value={form.purchasePrice} onChange={e => setForm(f => ({ ...f, purchasePrice: e.target.value }))} className={inputCls} />
            <input type="number" inputMode="numeric" placeholder="Sell price (DA)" value={form.sellPrice} onChange={e => setForm(f => ({ ...f, sellPrice: e.target.value }))} className={inputCls} />
            <Button onClick={save} disabled={saving} className="w-full mt-1">{saving ? <Loader2 size={15} className="animate-spin" /> : "Save Product"}</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- Finance ---------------- */
function AddExpenseForm({ onSave, onClose }) {
  const [form, setForm] = useState({ date: new Date().toISOString().slice(0,10), category: EXPENSE_CATEGORIES[0], amount: "", note: "" });
  const [saving, setSaving] = useState(false);
  const set = (k,v) => setForm(f => ({ ...f, [k]: v }));
  const submit = async () => { if (!form.amount || Number(form.amount) <= 0) return; setSaving(true); try { await onSave({ ...form, amount: Number(form.amount) }); onClose(); } finally { setSaving(false); } };
  return (
    <Modal title="Add Expense" onClose={onClose}>
      <div className="space-y-2.5">
        <input type="date" value={form.date} onChange={e => set("date", e.target.value)} className={inputCls} />
        <select value={form.category} onChange={e => set("category", e.target.value)} className={inputCls}>{EXPENSE_CATEGORIES.map(c => <option key={c}>{c}</option>)}</select>
        <input type="number" inputMode="numeric" placeholder="Amount (DA)" value={form.amount} onChange={e => set("amount", e.target.value)} className={inputCls} />
        <input placeholder="Note (e.g. campaign name)" value={form.note} onChange={e => set("note", e.target.value)} className={inputCls} />
        <Button onClick={submit} disabled={saving} className="w-full mt-1">{saving ? <Loader2 size={15} className="animate-spin" /> : "Save Expense"}</Button>
      </div>
    </Modal>
  );
}

function Finance({ leads, inventory, expenses, onAddExpense }) {
  const [period, setPeriod] = useState("month");
  const [adding, setAdding] = useState(false);
  const stats = useMemo(() => {
    const delivered = leads.filter(l => l.status === "Delivered" && withinPeriod(l.createdAt, period));
    const allOrders = leads.filter(l => ["Confirmed","Ready For Shipping","Shipped","In Transit","Delivered","Returned","Refunded"].includes(l.status) && withinPeriod(l.createdAt, period));
    const periodExpenses = expenses.filter(e => withinPeriod(e.date, period));
    const adSpend = periodExpenses.filter(e => e.category === "Ad Spend").reduce((s,e) => s + e.amount, 0);
    const otherExpenses = periodExpenses.filter(e => e.category !== "Ad Spend").reduce((s,e) => s + e.amount, 0);
    const revenue = delivered.reduce((s,l) => s + (l.codCollected || l.total || 0), 0);
    const cogs = delivered.reduce((s,l) => { const inv = inventory.find(i => i.name === l.product); return s + ((inv?.purchasePrice || 0) * (l.qty || 1)); }, 0);
    const shippingCosts = delivered.reduce((s,l) => s + (l.shippingCost || 0), 0);
    const grossProfit = revenue - cogs - shippingCosts;
    const netProfit = grossProfit - adSpend - otherExpenses;
    const roas = adSpend > 0 ? revenue / adSpend : 0;
    const costPerOrder = allOrders.length > 0 ? adSpend / allOrders.length : 0;
    const costPerDelivered = delivered.length > 0 ? adSpend / delivered.length : 0;
    return { revenue, cogs, shippingCosts, grossProfit, netProfit, adSpend, otherExpenses, roas, costPerOrder, costPerDelivered, deliveredCount: delivered.length, orderCount: allOrders.length };
  }, [leads, inventory, expenses, period]);
  const trend = useMemo(() => {
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const key = d.toDateString();
      const dayRevenue = leads.filter(l => l.status === "Delivered" && new Date(l.createdAt).toDateString() === key).reduce((s,l) => s + (l.codCollected || l.total || 0), 0);
      const daySpend = expenses.filter(e => e.category === "Ad Spend" && new Date(e.date).toDateString() === key).reduce((s,e) => s + e.amount, 0);
      days.push({ date: d.toLocaleDateString("fr-DZ", { day: "2-digit", month: "2-digit" }), Revenue: dayRevenue, "Ad Spend": daySpend });
    }
    return days;
  }, [leads, expenses]);
  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="flex items-center gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {PERIODS.map(p => <button key={p.id} onClick={() => setPeriod(p.id)} className={cx("shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium border", period === p.id ? "bg-amber-900 border-amber-600 text-amber-400" : "border-neutral-800 text-neutral-400 hover:text-neutral-200")}>{p.label}</button>)}
        <div className="flex-1 hidden sm:block" />
        <Button onClick={() => setAdding(true)} className="text-xs px-3 py-1.5 shrink-0 ml-auto sm:ml-0"><Plus size={14} /> Add Expense</Button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 sm:gap-3">
        <Card className="p-4"><div className="text-xs text-neutral-400 mb-1">Revenue</div><div className="text-lg sm:text-xl font-semibold text-white">{dz(stats.revenue)}</div></Card>
        <Card className="p-4"><div className="text-xs text-neutral-400 mb-1">Ad Spend</div><div className="text-lg sm:text-xl font-semibold text-white">{dz(stats.adSpend)}</div></Card>
        <Card className="p-4"><div className="text-xs text-neutral-400 mb-1">Net Profit</div><div className="text-lg sm:text-xl font-semibold" style={{ color: stats.netProfit >= 0 ? "#10B981" : "#EF4444" }}>{dz(stats.netProfit)}</div></Card>
        <Card className="p-4"><div className="text-xs text-neutral-400 mb-1">ROAS</div><div className="text-lg sm:text-xl font-semibold text-white">{stats.roas > 0 ? stats.roas.toFixed(2) + "x" : "—"}</div></Card>
      </div>
      <Card className="p-4">
        <div className="text-xs text-neutral-400 mb-3">Revenue vs. Ad Spend — last 14 days</div>
        <div style={{ width: "100%", height: 200 }}>
          <ResponsiveContainer><LineChart data={trend} margin={{ left: -20 }}><CartesianGrid strokeDasharray="3 3" stroke="#ffffff0f" /><XAxis dataKey="date" stroke="#ffffff40" fontSize={10} /><YAxis stroke="#ffffff40" fontSize={10} /><Tooltip contentStyle={{ background: "#15171F", border: "1px solid #ffffff1a", borderRadius: 8, fontSize: 12 }} /><Line type="monotone" dataKey="Revenue" stroke="#10B981" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="Ad Spend" stroke="#F0B429" strokeWidth={2} dot={false} /></LineChart></ResponsiveContainer>
        </div>
      </Card>
      <div className="grid md:grid-cols-2 gap-3">
        <Card className="p-4 space-y-2.5">
          <div className="text-xs text-neutral-400 mb-1">Profit Breakdown</div>
          {[["Revenue (delivered)", stats.revenue, "#fff"], ["− Cost of Goods", -stats.cogs, "#EF4444"], ["− Shipping Costs", -stats.shippingCosts, "#EF4444"], ["= Gross Profit", stats.grossProfit, "#0EA5E9"], ["− Ad Spend", -stats.adSpend, "#EF4444"], ["− Other Expenses", -stats.otherExpenses, "#EF4444"], ["= Net Profit", stats.netProfit, stats.netProfit >= 0 ? "#10B981" : "#EF4444"]].map(([label, val, color]) => <div key={label} className="flex items-center justify-between text-sm"><span className="text-neutral-400">{label}</span><span style={{ color }} className="tabular-nums font-medium">{dz(val)}</span></div>)}
        </Card>
        <Card className="p-4 space-y-2.5">
          <div className="text-xs text-neutral-400 mb-1">Unit Economics</div>
          <div className="flex items-center justify-between text-sm"><span className="text-neutral-400">Cost per Order</span><span className="text-white tabular-nums">{dz(stats.costPerOrder)}</span></div>
          <div className="flex items-center justify-between text-sm"><span className="text-neutral-400">Cost per Delivered Order</span><span className="text-white tabular-nums">{dz(stats.costPerDelivered)}</span></div>
          <div className="flex items-center justify-between text-sm"><span className="text-neutral-400">Orders in Period</span><span className="text-white tabular-nums">{stats.orderCount}</span></div>
          <div className="flex items-center justify-between text-sm"><span className="text-neutral-400">Delivered in Period</span><span className="text-white tabular-nums">{stats.deliveredCount}</span></div>
        </Card>
      </div>
      <Card className="p-4">
        <div className="text-xs text-neutral-400 mb-3">Recent Expenses</div>
        <div className="space-y-1.5">
          {[...expenses].sort((a,b) => new Date(b.date) - new Date(a.date)).slice(0,8).map(e => <div key={e.id} className="flex items-center justify-between text-sm py-1.5 border-b border-neutral-800 last:border-0 gap-2"><div className="truncate"><span className="text-neutral-200">{e.category}</span>{e.note && <span className="text-neutral-500 ml-2">· {e.note}</span>}</div><span className="text-neutral-300 tabular-nums shrink-0">{dz(e.amount)}</span></div>)}
          {expenses.length === 0 && <div className="text-neutral-600 text-sm">No expenses logged yet.</div>}
        </div>
      </Card>
      {adding && <AddExpenseForm onSave={onAddExpense} onClose={() => setAdding(false)} />}
    </div>
  );
}

/* ---------------- Shopify Import ---------------- */
function ShopifyImport({ leads, onImport }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const existingOrderIds = useMemo(() => new Set(leads.filter(l => l.shopifyOrderId).map(l => l.shopifyOrderId)), [leads]);
  const handleFile = (file) => {
    setParsing(true);
    Papa.parse(file, { header: true, skipEmptyLines: true, complete: (results) => {
      const grouped = {};
      results.data.forEach(row => { const orderId = row["Name"] || row["Id"]; if (!orderId) return; if (!grouped[orderId]) grouped[orderId] = { order: row, lines: [] }; if (row["Lineitem name"]) grouped[orderId].lines.push(row); });
      const rows = Object.values(grouped).map(({ order, lines }) => { const line = lines[0] || order; return {
        shopifyOrderId: order["Name"], name: order["Shipping Name"] || order["Billing Name"] || "Client",
        phone: (order["Shipping Phone"] || order["Phone"] || order["Billing Phone"] || "").replace(/\s+/g, ""),
        wilaya: order["Shipping Province"] || order["Shipping Province Name"] || "—", commune: order["Shipping City"] || "",
        address: [order["Shipping Address1"], order["Shipping Address2"]].filter(Boolean).join(", "),
        product: line["Lineitem name"] || "—", qty: Number(line["Lineitem quantity"]) || 1, price: Number(line["Lineitem price"]) || 0,
        total: Number(order["Total"]) || 0, createdAt: order["Created at"] ? new Date(order["Created at"]).toISOString() : new Date().toISOString(),
        alreadyImported: existingOrderIds.has(order["Name"]),
      };}).filter(r => r.shopifyOrderId);
      setPreview(rows); setParsing(false);
    }, error: () => setParsing(false) });
  };
  const confirmImport = async () => {
    const toImport = preview.filter(r => !r.alreadyImported && r.phone);
    setImporting(true);
    try {
      await onImport(toImport.map(r => ({ shopifyOrderId: r.shopifyOrderId, name: r.name, phone: r.phone, phone2: "", wilaya: r.wilaya, commune: r.commune, address: r.address, product: r.product, qty: r.qty, price: r.price, shippingCost: 0, total: r.total || (r.price * r.qty), source: "Shopify Import", notes: "", status: "New Lead", createdAt: r.createdAt })));
      setPreview(null);
    } finally { setImporting(false); }
  };
  const newCount = preview ? preview.filter(r => !r.alreadyImported).length : 0;
  const skipCount = preview ? preview.filter(r => r.alreadyImported).length : 0;
  const missingPhone = preview ? preview.filter(r => !r.alreadyImported && !r.phone).length : 0;
  return (
    <div className="space-y-4 sm:space-y-5">
      <Card className="p-4 sm:p-5">
        <div className="flex items-start gap-3 mb-4">
          <FileSpreadsheet size={20} className="text-amber-400 shrink-0 mt-0.5" />
          <div><div className="text-white font-medium text-sm">Import orders from Shopify CSV</div><div className="text-neutral-400 text-xs mt-1">In Shopify admin: Orders → Export → export as CSV. Every order becomes a new lead starting at "New Lead" — COD orders still need a call before they count as sales.</div></div>
        </div>
        <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={e => e.target.files[0] && handleFile(e.target.files[0])} />
        <Button onClick={() => fileRef.current?.click()} className="w-full sm:w-auto">{parsing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}{parsing ? "Reading file..." : "Choose CSV File"}</Button>
      </Card>
      {preview && (
        <Card className="p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
            <div className="text-sm text-neutral-300"><span className="text-emerald-400 font-medium">{newCount} new</span> · <span className="text-neutral-500">{skipCount} already imported</span>{missingPhone > 0 && <span className="text-amber-400"> · {missingPhone} missing phone</span>}</div>
            <Button onClick={confirmImport} disabled={newCount === 0 || importing} className="text-xs px-3 py-2">{importing ? <Loader2 size={14} className="animate-spin" /> : `Import ${newCount} Orders`}</Button>
          </div>
          <div className="max-h-72 overflow-y-auto overflow-x-auto rounded-lg border border-neutral-800">
            <table className="w-full text-xs">
              <thead><tr className="bg-black text-neutral-500 uppercase tracking-wide"><th className="text-left px-3 py-2 font-medium">Order</th><th className="text-left px-3 py-2 font-medium">Customer</th><th className="text-left px-3 py-2 font-medium">Wilaya</th><th className="text-left px-3 py-2 font-medium">Product</th><th className="text-left px-3 py-2 font-medium">Total</th><th className="text-left px-3 py-2 font-medium">Status</th></tr></thead>
              <tbody>{preview.map(r => <tr key={r.shopifyOrderId} className="border-t border-neutral-800"><td className="px-3 py-2 text-neutral-300">{r.shopifyOrderId}</td><td className="px-3 py-2 text-neutral-300">{r.name}</td><td className="px-3 py-2 text-neutral-400">{r.wilaya}</td><td className="px-3 py-2 text-neutral-400">{r.product}</td><td className="px-3 py-2 text-neutral-400">{dz(r.total)}</td><td className="px-3 py-2">{r.alreadyImported ? <span className="text-neutral-600">Already imported</span> : !r.phone ? <span className="text-amber-400">No phone</span> : <span className="text-emerald-400">Ready</span>}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
      )}
      <Card className="p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <CloudUpload size={20} className="text-neutral-600 shrink-0 mt-0.5" />
          <div><div className="text-white font-medium text-sm">Live auto-sync (not connected)</div><div className="text-neutral-400 text-xs mt-1">Real-time sync needs a small always-on backend holding your Shopify API credentials — Shopify blocks direct browser calls for security. CSV import above works right now.</div></div>
        </div>
      </Card>
    </div>
  );
}

/* ---------------- Navigation ---------------- */
const NAV = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, roles: null },
  { id: "queue", label: "Confirmation Queue", short: "Queue", icon: PhoneCall, badgeKey: "queue", roles: ["owner","confirmation_agent"] },
  { id: "leads", label: "Leads / CRM", short: "Leads", icon: Users, roles: ["owner","confirmation_agent"] },
  { id: "orders", label: "Orders", icon: Package, roles: null },
  { id: "delivery", label: "Delivery", icon: Truck, badgeKey: "delivery", roles: ["owner","warehouse","delivery"] },
  { id: "returns", label: "Returns & Cancellations", short: "Returns", icon: RotateCcw, roles: null },
  { id: "inventory", label: "Inventory", icon: Boxes, roles: null },
  { id: "finance", label: "Finance", icon: DollarSign, roles: ["owner","accountant"] },
  { id: "shopify", label: "Shopify Import", short: "Shopify", icon: CloudUpload, roles: ["owner"] },
];
const MOBILE_PRIMARY = ["dashboard", "queue", "leads", "delivery"];

/* ---------------- App Shell ---------------- */
export default function CODOperatingSystem() {
  const { session, profile, authReady, login, logout, rest } = useSupabaseSession();
  const data = useSupabaseData(session, rest);
  const [tab, setTab] = useState("dashboard");
  const [showForm, setShowForm] = useState(false);
  const [openLead, setOpenLead] = useState(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const role = profile?.role || "confirmation_agent";
  const visibleNav = NAV.filter(n => !n.roles || n.roles.includes(role));
  const canEditInventory = role === "owner" || role === "warehouse";

  const badges = {
    queue: data.leads.filter(l => QUEUE_STATUSES.includes(l.status)).length,
    delivery: data.leads.filter(l => ["Ready For Shipping","Shipped","In Transit"].includes(l.status)).length,
  };

  const goTo = (id) => { setTab(id); setMoreOpen(false); };
  const currentNav = NAV.find(n => n.id === tab) || visibleNav[0];

  useEffect(() => { if (!visibleNav.find(n => n.id === tab)) setTab(visibleNav[0]?.id || "dashboard"); }, [role]); // eslint-disable-line

  if (!authReady) return <div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="animate-spin text-amber-500" size={24} /></div>;
  if (!session) return <LoginScreen onLogin={login} />;
  if (data.loading) return <div className="min-h-screen bg-black flex items-center justify-center"><Loader2 className="animate-spin text-amber-500" size={24} /></div>;

  return (
    <div className="min-h-screen bg-black text-white" style={{ fontFamily: "'Inter', -apple-system, sans-serif" }}>
      <GlobalStyles />
      <div className="lg:flex lg:min-h-screen">
        <aside className="hidden lg:flex lg:w-60 border-r border-neutral-800 flex-col shrink-0 lg:sticky lg:top-0 lg:h-screen">
          <div className="px-5 py-5 border-b border-neutral-800">
            <div className="text-sm font-semibold tracking-tight">COD Operating System</div>
            <div className="text-xs text-neutral-500 mt-0.5">Algeria</div>
          </div>
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
            {visibleNav.map(n => (
              <button key={n.id} onClick={() => setTab(n.id)} className={cx("w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-colors", tab === n.id ? "bg-amber-900 text-amber-400" : "text-neutral-400 hover:bg-neutral-800 hover:text-white")}>
                <span className="flex items-center gap-2.5"><n.icon size={16} />{n.label}</span>
                {!!badges[n.badgeKey] && <span className="text-xs bg-amber-500 text-black rounded-full px-1.5 py-0.5 font-medium">{badges[n.badgeKey]}</span>}
              </button>
            ))}
          </nav>
          <div className="p-3 border-t border-neutral-800 space-y-2">
            {data.error && <div className="text-red-400 text-xs px-1">{data.error}</div>}
            <Button onClick={() => setShowForm(true)} className="w-full"><Plus size={15} /> New Lead</Button>
            <div className="flex items-center justify-between px-1 pt-1">
              <div className="text-xs text-neutral-400 truncate">{profile?.full_name || session.user.email} <span className="text-neutral-600">· {role.replace("_"," ")}</span></div>
              <button onClick={logout} className="text-neutral-500 hover:text-white p-1"><LogOut size={14} /></button>
            </div>
          </div>
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <div className="lg:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-14 border-b border-neutral-800 bg-black">
            <div><div className="text-sm font-semibold leading-none">{currentNav?.label}</div><div className="text-xs text-neutral-600 mt-0.5">COD Operating System</div></div>
            <button onClick={() => setMoreOpen(true)} className="p-2 -m-2 rounded-lg hover:bg-neutral-800 text-neutral-400"><Menu size={18} /></button>
          </div>

          <main className="flex-1 overflow-y-auto pb-24 lg:pb-0">
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5 sm:py-6">
              <div className="mb-5 hidden lg:block"><h1 className="text-lg font-medium">{currentNav?.label}</h1></div>
              {data.error && <div className="lg:hidden text-red-400 text-sm mb-4">{data.error}</div>}
              <div key={tab} className="tab-enter">
                {tab === "dashboard" && <Dashboard leads={data.leads} inventory={data.inventory} />}
                {tab === "queue" && <ConfirmationQueue leads={data.leads} onUpdate={data.updateLead} />}
                {tab === "leads" && <LeadsTable leads={data.leads} onOpen={setOpenLead} />}
                {tab === "orders" && <LeadsTable leads={data.leads} onOpen={setOpenLead} filterStatuses={ORDER_STATUSES.concat(["Delivered","Returned","Refunded"])} />}
                {tab === "delivery" && <DeliveryBoard leads={data.leads} onUpdate={data.updateLead} />}
                {tab === "returns" && <ReturnsBoard leads={data.leads} onUpdate={data.updateLead} />}
                {tab === "inventory" && <Inventory inventory={data.inventory} canEdit={canEditInventory} onAdd={data.addInventoryItem} onAdjust={(id, stock) => data.updateInventoryItem(id, { stock })} />}
                {tab === "finance" && <Finance leads={data.leads} inventory={data.inventory} expenses={data.expenses} onAddExpense={data.addExpense} />}
                {tab === "shopify" && <ShopifyImport leads={data.leads} onImport={data.importLeads} />}
              </div>
            </div>
          </main>
        </div>
      </div>

      <div className="lg:hidden fixed bottom-0 inset-x-0 z-40 border-t border-neutral-800 bg-black">
        <div className="flex items-stretch justify-around h-16" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {MOBILE_PRIMARY.filter(id => visibleNav.find(n => n.id === id)).map(id => {
            const n = NAV.find(x => x.id === id); const active = tab === id;
            return (
              <button key={id} onClick={() => goTo(id)} className="flex-1 flex flex-col items-center justify-center gap-0.5">
                <span className="relative inline-flex">
                  <n.icon size={20} className={active ? "text-amber-400" : "text-neutral-500"} />
                  {!!badges[n.badgeKey] && <span className="absolute -top-1.5 -right-2 w-4 h-4 rounded-full bg-amber-500 text-black text-xs font-bold flex items-center justify-center">{badges[n.badgeKey]}</span>}
                </span>
                <span className={cx("text-xs", active ? "text-amber-400 font-medium" : "text-neutral-500")}>{n.short || n.label}</span>
              </button>
            );
          })}
          <button onClick={() => setMoreOpen(true)} className="flex-1 flex flex-col items-center justify-center gap-0.5"><MoreHorizontal size={20} className="text-neutral-500" /><span className="text-xs text-neutral-500">More</span></button>
        </div>
      </div>

      <button onClick={() => setShowForm(true)} className="lg:hidden fixed right-4 bottom-20 z-40 w-14 h-14 rounded-full bg-amber-500 active:bg-amber-400 text-black flex items-center justify-center shadow-lg" style={{ boxShadow: "0 10px 25px -5px rgba(245,158,11,0.4)" }}><Plus size={22} /></button>

      {moreOpen && (
        <Modal title="Menu" onClose={() => setMoreOpen(false)}>
          <div className="space-y-1">
            {visibleNav.map(n => <button key={n.id} onClick={() => goTo(n.id)} className={cx("w-full flex items-center justify-between px-3 py-3 rounded-lg text-sm", tab === n.id ? "bg-amber-900 text-amber-400" : "text-neutral-300 hover:bg-neutral-800")}><span className="flex items-center gap-3"><n.icon size={17} />{n.label}</span>{!!badges[n.badgeKey] && <span className="text-xs bg-amber-500 text-black rounded-full px-1.5 py-0.5 font-medium">{badges[n.badgeKey]}</span>}</button>)}
            <div className="pt-2 mt-2 border-t border-neutral-800">
              <div className="px-3 py-2 text-xs text-neutral-500">{profile?.full_name || session.user.email} · {role.replace("_"," ")}</div>
              <button onClick={logout} className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm text-red-400 hover:bg-neutral-800"><LogOut size={17} /> Sign Out</button>
            </div>
          </div>
        </Modal>
      )}

      {showForm && <LeadForm onSave={data.addLead} onClose={() => setShowForm(false)} inventory={data.inventory} />}
      {openLead && <LeadDetail lead={data.leads.find(l => l.id === openLead.id) || openLead} history={data.history[openLead.id]} onClose={() => setOpenLead(null)} onUpdate={data.updateLead} />}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Input, ModelSelectModal, SegmentedControl } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const TABS = [
  { value: "alias", label: "Alias", icon: "label" },
  { value: "routing", label: "Routing", icon: "alt_route" },
];

// ── Shared pieces ──────────────────────────────────────────────

/** Centered empty state. The old cards rendered a bare sentence pinned to the
 *  top-left of a padding-less card, which read as a rendering glitch. */
function EmptyState({ icon, title, hint }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-surface-2">
        <span className="material-symbols-outlined text-[22px] text-text-muted">{icon}</span>
      </div>
      <p className="text-sm font-medium text-text-main">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-xs text-text-muted">{hint}</p>}
    </div>
  );
}

/** A "from → to" row used by both tabs. Alias rows lead with the alias chip;
 *  routing rows lead with the full source id. */
function MappingRow({ lead, leadVariant = "chip", target, onDelete }) {
  return (
    <div className="group flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-surface-2/60">
      {leadVariant === "chip" ? (
        <Badge variant="primary" size="md" className="shrink-0">
          {lead}
        </Badge>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-main">{lead}</span>
      )}
      <span className="material-symbols-outlined shrink-0 text-[16px] text-text-muted">arrow_forward</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-muted">{target}</span>
      <button
        onClick={onDelete}
        title="Delete"
        className="shrink-0 rounded-lg p-1.5 text-text-muted opacity-0 transition-all hover:bg-red-500/10 hover:text-red-500 focus:opacity-100 group-hover:opacity-100"
      >
        <span className="material-symbols-outlined text-[18px]">delete</span>
      </button>
    </div>
  );
}

/** Model id field with a picker button. Mirrors the Input label styling so the
 *  two columns line up when the fields sit side by side. */
function ModelField({ label, value, onChange, onPick, placeholder }) {
  return (
    <div className="min-w-0 flex-1">
      <label className="mb-1.5 block text-sm font-medium text-text-main">{label}</label>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button variant="secondary" onClick={onPick} title="Pick a model">
          <span className="material-symbols-outlined text-[18px]">search</span>
        </Button>
      </div>
    </div>
  );
}

function CardHeader({ count, children }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-text-main">{children}</span>
        <Badge variant="default" size="sm">{count}</Badge>
      </div>
    </div>
  );
}

// ── Alias tab ──────────────────────────────────────────────────
// A short freetext name (no "/") that resolves to a real model.

function AliasTab({ aliases, activeProviders, onChanged }) {
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [alias, setAlias] = useState("");
  const [model, setModel] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [error, setError] = useState("");

  const rows = useMemo(
    () => Object.entries(aliases || {}).map(([name, target]) => ({ name, target }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [aliases]
  );

  const handleSave = async () => {
    const name = alias.trim();
    const target = model.trim();
    if (!name || !target) {
      setError("Both the alias and the target model are required");
      return;
    }
    // An alias is a bare name. A "/" would make it parse as provider/model and
    // the alias lookup would never fire — see parseModel in src/sse/services/model.js.
    if (name.includes("/")) {
      setError('An alias cannot contain "/" — use Routing to remap an existing model');
      return;
    }
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: name, model: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save alias");
      addNotification({ type: "success", message: `Alias "${name}" → ${target}` });
      setAlias("");
      setModel("");
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(pendingDelete)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete alias");
      addNotification({ type: "success", message: `Alias "${pendingDelete}" removed` });
      await onChanged();
    } catch (e) {
      addNotification({ type: "error", message: e.message });
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Create alias"
        subtitle="A short name you can use anywhere a model id is accepted"
        icon="label"
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Input
              label="Alias"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. deepseek"
              className="sm:w-56 sm:shrink-0"
            />
            <ModelField
              label="Target model"
              value={model}
              onChange={setModel}
              onPick={() => setShowPicker(true)}
              placeholder="e.g. wb/deepseek-v4.1-flash"
            />
          </div>
          {error && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {error}
            </p>
          )}
          <Button onClick={handleSave} disabled={saving} loading={saving} icon="add">
            {saving ? "Saving…" : "Save alias"}
          </Button>
        </div>
      </Card>

      <div className="overflow-hidden rounded-[14px] border border-border-subtle bg-surface shadow-[var(--shadow-soft)]">
        <CardHeader count={rows.length}>Aliases</CardHeader>
        {rows.length === 0 ? (
          <EmptyState
            icon="label"
            title="No aliases yet"
            hint="Create one above to give a model a short, memorable name."
          />
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <MappingRow
                key={row.name}
                lead={row.name}
                leadVariant="chip"
                target={row.target}
                onDelete={() => setPendingDelete(row.name)}
              />
            ))}
          </div>
        )}
      </div>

      <ModelSelectModal
        isOpen={showPicker}
        onClose={() => setShowPicker(false)}
        onSelect={(m) => setModel(m?.value || "")}
        activeProviders={activeProviders}
        title="Select Target Model"
        modelAliases={aliases}
      />

      <ConfirmModal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        title="Delete alias"
        message={`Remove alias "${pendingDelete}"?`}
        confirmText="Delete"
      />
    </div>
  );
}

// ── Routing tab ────────────────────────────────────────────────
// Remap an EXISTING model onto another EXISTING model. The client keeps asking
// for model A; the router runs model B and records B in usage history. A is
// preserved as `requestedModel` on the request detail.

function RoutingTab({ routes, activeProviders, modelAliases, onChanged }) {
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pickerFor, setPickerFor] = useState(null); // "from" | "to" | null
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [error, setError] = useState("");

  const rows = useMemo(
    () => Object.entries(routes || {}).map(([source, target]) => ({ source, target }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    [routes]
  );

  const handleSave = async () => {
    const src = from.trim();
    const dst = to.trim();
    if (!src || !dst) {
      setError("Both the source and target models are required");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const res = await fetch("/api/models/routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: src, to: dst }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save route");
      addNotification({ type: "success", message: `${src} now routes to ${dst}` });
      // Non-fatal: the route saved, but a model id is outside the local list.
      for (const warning of data.warnings || []) {
        addNotification({ type: "warning", message: warning, duration: 8000 });
      }
      setFrom("");
      setTo("");
      await onChanged();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    try {
      const res = await fetch(`/api/models/routing?from=${encodeURIComponent(pendingDelete)}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete route");
      addNotification({ type: "success", message: `Route for "${pendingDelete}" removed` });
      await onChanged();
    } catch (e) {
      addNotification({ type: "error", message: e.message });
    } finally {
      setPendingDelete(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card
        title="Create route"
        subtitle="Requests for one model are served by another — the client keeps using the original id"
        icon="alt_route"
      >
        <div className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
            <ModelField
              label="When a request asks for"
              value={from}
              onChange={setFrom}
              onPick={() => setPickerFor("from")}
              placeholder="e.g. cmc/deepseek/deepseek-v4.1-flash"
            />
            <div className="hidden shrink-0 items-center justify-center pb-2 lg:flex">
              <span className="material-symbols-outlined text-[20px] text-text-muted">arrow_forward</span>
            </div>
            <ModelField
              label="Run instead"
              value={to}
              onChange={setTo}
              onPick={() => setPickerFor("to")}
              placeholder="e.g. wb/deepseek-v4.1-flash"
            />
          </div>
          {error && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={handleSave} disabled={saving} loading={saving} icon="add">
              {saving ? "Saving…" : "Save route"}
            </Button>
            <p className="text-xs text-text-muted">
              Both models must already exist. Usage is recorded against the target.
            </p>
          </div>
        </div>
      </Card>

      <div className="overflow-hidden rounded-[14px] border border-border-subtle bg-surface shadow-[var(--shadow-soft)]">
        <CardHeader count={rows.length}>Routes</CardHeader>
        {rows.length === 0 ? (
          <EmptyState
            icon="alt_route"
            title="No routes yet"
            hint="Add one above to silently serve a model with a different one."
          />
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <MappingRow
                key={row.source}
                lead={row.source}
                leadVariant="text"
                target={row.target}
                onDelete={() => setPendingDelete(row.source)}
              />
            ))}
          </div>
        )}
      </div>

      <ModelSelectModal
        isOpen={!!pickerFor}
        onClose={() => setPickerFor(null)}
        onSelect={(m) => {
          const value = m?.value || "";
          if (pickerFor === "from") setFrom(value);
          else setTo(value);
        }}
        activeProviders={activeProviders}
        title={pickerFor === "from" ? "Select Source Model" : "Select Target Model"}
        modelAliases={modelAliases}
      />

      <ConfirmModal
        isOpen={!!pendingDelete}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
        title="Delete route"
        message={`Requests for "${pendingDelete}" will go to the provider directly again.`}
        confirmText="Delete"
      />
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────

export default function RoutingPage() {
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [tab, setTab] = useState("routing");
  const [loading, setLoading] = useState(true);
  const [aliases, setAliases] = useState({});
  const [routes, setRoutes] = useState({});
  const [activeProviders, setActiveProviders] = useState([]);

  const loadData = useCallback(async () => {
    try {
      const [aliasRes, routeRes, providersRes] = await Promise.all([
        fetch("/api/models/alias", { cache: "no-store" }),
        fetch("/api/models/routing", { cache: "no-store" }),
        fetch("/api/providers"),
      ]);
      const aliasData = await aliasRes.json();
      const routeData = await routeRes.json();
      const providersData = providersRes.ok ? await providersRes.json() : {};
      if (aliasRes.ok) setAliases(aliasData.aliases || {});
      if (routeRes.ok) setRoutes(routeData.routes || {});
      setActiveProviders(providersData.connections || []);
    } catch (e) {
      addNotification({ type: "error", message: "Failed to load routing data" });
      console.log("routing page load error:", e);
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <CardSkeleton />;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-1 sm:gap-6 sm:px-0">
      {/* Title and tabs share one row so the control centres against the
          heading itself. Centring it against the heading+subtitle block (the
          previous layout) left it floating between the two lines. */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold text-text-main sm:text-2xl">Alias &amp; Routing</h1>
          <SegmentedControl options={TABS} value={tab} onChange={setTab} className="shrink-0" />
        </div>
        <p className="text-sm text-text-muted">
          Give a model a short name, or quietly serve it with a different one.
        </p>
      </div>

      {tab === "alias" ? (
        <AliasTab
          aliases={aliases}
          activeProviders={activeProviders}
          onChanged={loadData}
        />
      ) : (
        <RoutingTab
          routes={routes}
          activeProviders={activeProviders}
          modelAliases={aliases}
          onChanged={loadData}
        />
      )}
    </div>
  );
}

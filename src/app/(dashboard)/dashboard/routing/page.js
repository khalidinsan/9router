"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardSkeleton, ConfirmModal, Input, ModelSelectModal, SegmentedControl } from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";

const TABS = [
  { value: "alias", label: "Alias", icon: "label" },
  { value: "routing", label: "Routing", icon: "alt_route" },
];

// ── Alias tab ──────────────────────────────────────────────────
// A short freetext name (no "/") that resolves to a real model.
// Existing behaviour, surfaced here so both features live in one place.

function AliasTab({ aliases, activeProviders, modelAliases, onChanged }) {
  const addNotification = useNotificationStore((s) => s.addNotification);
  const [alias, setAlias] = useState("");
  const [model, setModel] = useState("");
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [error, setError] = useState("");

  const rows = useMemo(() => {
    return Object.entries(aliases || {})
      .map(([name, target]) => ({ name, target }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [aliases]);

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
      <Card title="Create Alias" subtitle="A short name you can use anywhere a model id is accepted">
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3 items-end">
            <Input
              label="Alias"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. deepseek"
              className="sm:w-56"
            />
            <div className="flex-1 w-full">
              <label className="block text-sm font-medium text-text-main mb-1.5">Target model</label>
              <div className="flex gap-2">
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. wb/deepseek-v4.1-flash"
                  className="flex-1"
                />
                <Button variant="secondary" onClick={() => setShowPicker(true)}>
                  <span className="material-symbols-outlined text-[18px]">search</span>
                </Button>
              </div>
            </div>
          </div>
          {error && <p className="text-xs text-error">{error}</p>}
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save Alias"}
          </Button>
        </div>
      </Card>

      <Card title={`Aliases (${rows.length})`} padding="none">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-text-muted">No aliases yet.</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <div key={row.name} className="flex items-center gap-3 p-4">
                <Badge variant="primary">{row.name}</Badge>
                <span className="material-symbols-outlined text-[16px] text-text-muted">arrow_forward</span>
                <span className="font-mono text-xs text-text-main truncate flex-1">{row.target}</span>
                <Button variant="ghost" size="sm" onClick={() => setPendingDelete(row.name)}>
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <ModelSelectModal
        isOpen={showPicker}
        onClose={() => setShowPicker(false)}
        onSelect={(m) => setModel(m?.value || "")}
        activeProviders={activeProviders}
        title="Select Target Model"
        modelAliases={modelAliases}
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

  const rows = useMemo(() => {
    return Object.entries(routes || {})
      .map(([source, target]) => ({ source, target }))
      .sort((a, b) => a.source.localeCompare(b.source));
  }, [routes]);

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
      <Card title="Create Route" subtitle="Send requests for one model to another — the client keeps using the original id">
        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="flex-1">
              <label className="block text-sm font-medium text-text-main mb-1.5">When a request asks for</label>
              <div className="flex gap-2">
                <Input
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  placeholder="e.g. cmc/deepseek/deepseek-v4.1-flash"
                  className="flex-1"
                />
                <Button variant="secondary" onClick={() => setPickerFor("from")}>
                  <span className="material-symbols-outlined text-[18px]">search</span>
                </Button>
              </div>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium text-text-main mb-1.5">Run instead</label>
              <div className="flex gap-2">
                <Input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="e.g. wb/deepseek-v4.1-flash"
                  className="flex-1"
                />
                <Button variant="secondary" onClick={() => setPickerFor("to")}>
                  <span className="material-symbols-outlined text-[18px]">search</span>
                </Button>
              </div>
            </div>
          </div>
          {error && <p className="text-xs text-error">{error}</p>}
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save Route"}
          </Button>
          <p className="text-xs text-text-muted">
            Both models must already exist. Usage history records the target model; the original
            request id is kept on the request detail as <span className="font-mono">requestedModel</span>.
          </p>
        </div>
      </Card>

      <Card title={`Routes (${rows.length})`} padding="none">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-text-muted">No routes yet.</p>
        ) : (
          <div className="divide-y divide-border-subtle">
            {rows.map((row) => (
              <div key={row.source} className="flex items-center gap-3 p-4">
                <span className="font-mono text-xs text-text-main truncate flex-1">{row.source}</span>
                <span className="material-symbols-outlined text-[16px] text-text-muted">arrow_forward</span>
                <span className="font-mono text-xs text-text-main truncate flex-1">{row.target}</span>
                <Button variant="ghost" size="sm" onClick={() => setPendingDelete(row.source)}>
                  <span className="material-symbols-outlined text-[18px]">delete</span>
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

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
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-main">Alias &amp; Routing</h1>
          <p className="text-sm text-text-muted mt-1">
            Give a model a short name, or send requests for one model to another.
          </p>
        </div>
        <SegmentedControl options={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === "alias" ? (
        <AliasTab
          aliases={aliases}
          activeProviders={activeProviders}
          modelAliases={aliases}
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

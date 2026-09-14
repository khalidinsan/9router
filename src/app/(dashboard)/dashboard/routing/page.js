"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
  ConfirmModal,
  Input,
  Modal,
  ModelSelectModal,
  SegmentedControl,
} from "@/shared/components";
import { useNotificationStore } from "@/store/notificationStore";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";

export default function RoutingPage() {
  const addNotification = useNotificationStore((s) => s.addNotification);
  const { copied, copy } = useCopyToClipboard(2000);

  const [tab, setTab] = useState("routing");
  const [loading, setLoading] = useState(true);
  const [aliases, setAliases] = useState({});
  const [routes, setRoutes] = useState({});
  const [activeProviders, setActiveProviders] = useState([]);

  // Modals state
  const [showAddRouteModal, setShowAddRouteModal] = useState(false);
  const [showAddAliasModal, setShowAddAliasModal] = useState(false);
  const [pendingDeleteRoute, setPendingDeleteRoute] = useState(null);
  const [pendingDeleteAlias, setPendingDeleteAlias] = useState(null);

  // Form states
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [pickerFor, setPickerFor] = useState(null); // "from" | "to" | null
  const [routeError, setRouteError] = useState("");

  const [alias, setAlias] = useState("");
  const [aliasModel, setAliasModel] = useState("");
  const [showAliasPicker, setShowAliasPicker] = useState(false);
  const [aliasError, setAliasError] = useState("");

  const [saving, setSaving] = useState(false);

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
      console.error("Routing page load error:", e);
    } finally {
      setLoading(false);
    }
  }, [addNotification]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const routeEntries = useMemo(
    () =>
      Object.entries(routes || {})
        .map(([source, target]) => ({ source, target }))
        .sort((a, b) => a.source.localeCompare(b.source)),
    [routes]
  );

  const aliasEntries = useMemo(
    () =>
      Object.entries(aliases || {})
        .map(([name, target]) => ({ name, target }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [aliases]
  );

  // ── Route handlers ─────────────────────────────────────────────
  const handleSaveRoute = async () => {
    const src = from.trim();
    const dst = to.trim();
    if (!src || !dst) {
      setRouteError("Both source and target models are required");
      return;
    }
    setRouteError("");
    setSaving(true);
    try {
      const res = await fetch("/api/models/routing", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: src, to: dst }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save route");

      addNotification({ type: "success", message: `Route configured: ${src} → ${dst}` });
      for (const warning of data.warnings || []) {
        addNotification({ type: "warning", message: warning, duration: 8000 });
      }

      setFrom("");
      setTo("");
      setShowAddRouteModal(false);
      await loadData();
    } catch (e) {
      setRouteError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRoute = async () => {
    if (!pendingDeleteRoute) return;
    try {
      const res = await fetch(`/api/models/routing?from=${encodeURIComponent(pendingDeleteRoute)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete route");
      addNotification({ type: "success", message: `Route for "${pendingDeleteRoute}" deleted` });
      await loadData();
    } catch (e) {
      addNotification({ type: "error", message: e.message });
    } finally {
      setPendingDeleteRoute(null);
    }
  };

  // ── Alias handlers ─────────────────────────────────────────────
  const handleSaveAlias = async () => {
    const name = alias.trim();
    const target = aliasModel.trim();
    if (!name || !target) {
      setAliasError("Both alias name and target model are required");
      return;
    }
    if (name.includes("/")) {
      setAliasError('An alias cannot contain "/" — use Routing to remap model IDs');
      return;
    }
    setAliasError("");
    setSaving(true);
    try {
      const res = await fetch("/api/models/alias", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alias: name, model: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save alias");

      addNotification({ type: "success", message: `Alias created: "${name}" → ${target}` });
      setAlias("");
      setAliasModel("");
      setShowAddAliasModal(false);
      await loadData();
    } catch (e) {
      setAliasError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteAlias = async () => {
    if (!pendingDeleteAlias) return;
    try {
      const res = await fetch(`/api/models/alias?alias=${encodeURIComponent(pendingDeleteAlias)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete alias");
      addNotification({ type: "success", message: `Alias "${pendingDeleteAlias}" deleted` });
      await loadData();
    } catch (e) {
      addNotification({ type: "error", message: e.message });
    } finally {
      setPendingDeleteAlias(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Top Action / Nav Bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <SegmentedControl
          options={[
            { value: "routing", label: `Routes (${routeEntries.length})`, icon: "alt_route" },
            { value: "alias", label: `Aliases (${aliasEntries.length})`, icon: "label" },
          ]}
          value={tab}
          onChange={setTab}
          className="w-full sm:w-auto"
        />

        <div className="flex items-center gap-2">
          {tab === "routing" ? (
            <Button
              icon="add"
              onClick={() => {
                setRouteError("");
                setShowAddRouteModal(true);
              }}
              className="w-full sm:w-auto"
            >
              Create Route
            </Button>
          ) : (
            <Button
              icon="add"
              onClick={() => {
                setAliasError("");
                setShowAddAliasModal(true);
              }}
              className="w-full sm:w-auto"
            >
              Create Alias
            </Button>
          )}
        </div>
      </div>

      {/* ── Routing Tab ────────────────────────────────────────── */}
      {tab === "routing" && (
        <>
          {routeEntries.length === 0 ? (
            <Card>
              <div className="py-12 text-center">
                <div className="mb-4 inline-flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-[var(--shadow-warm)]">
                  <span className="material-symbols-outlined text-[32px]">alt_route</span>
                </div>
                <h3 className="mb-1 text-base font-semibold text-text-main">No model routes configured</h3>
                <p className="mx-auto mb-5 max-w-md text-sm text-text-muted">
                  Transparently forward requests from model A to model B. If the target model fails, 9Router automatically falls back to the original model.
                </p>
                <Button
                  icon="add"
                  onClick={() => {
                    setRouteError("");
                    setShowAddRouteModal(true);
                  }}
                >
                  Create First Route
                </Button>
              </div>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {routeEntries.map((item) => (
                <Card
                  key={item.source}
                  padding="sm"
                  className="group transition-all hover:border-brand-500/30"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <span className="material-symbols-outlined text-[20px]">alt_route</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <code
                            className="max-w-[280px] truncate rounded-md border border-border-subtle bg-surface-2 px-2.5 py-1 font-mono text-xs text-text-main"
                            title={item.source}
                          >
                            {item.source}
                          </code>
                          <span className="material-symbols-outlined shrink-0 text-[16px] text-primary">
                            arrow_forward
                          </span>
                          <code
                            className="max-w-[280px] truncate rounded-md border border-primary/20 bg-primary/10 px-2.5 py-1 font-mono text-xs font-semibold text-primary"
                            title={item.target}
                          >
                            {item.target}
                          </code>
                          <Badge variant="success" size="sm" dot>
                            Active
                          </Badge>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
                          <span>
                            Request: <code className="font-mono text-[11px] text-text-main">{item.source}</code> &rarr; Runs: <code className="font-mono text-[11px] text-primary">{item.target}</code>
                          </span>
                          <span className="hidden text-text-muted/40 sm:inline">&bull;</span>
                          <span className="flex items-center gap-0.5 text-[11px] text-emerald-600 dark:text-emerald-400">
                            <span className="material-symbols-outlined text-[13px]">verified_user</span>
                            Auto-fallback on target failure
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
                      <button
                        onClick={() => copy(item.source, `src-${item.source}`)}
                        className="rounded p-1.5 text-text-muted transition-colors hover:bg-surface-2 hover:text-primary"
                        title="Copy source model ID"
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {copied === `src-${item.source}` ? "check" : "content_copy"}
                        </span>
                      </button>
                      <button
                        onClick={() => setPendingDeleteRoute(item.source)}
                        className="rounded p-1.5 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                        title="Delete route"
                      >
                        <span className="material-symbols-outlined text-[18px]">delete</span>
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Educational tip card */}
          <Card padding="sm" className="border-border-subtle bg-surface-2/40">
            <div className="flex items-start gap-3">
              <span className="material-symbols-outlined mt-0.5 shrink-0 text-[20px] text-primary">
                info
              </span>
              <div className="space-y-1 text-xs text-text-muted">
                <p className="font-semibold text-text-main">How Transparent Routing Works</p>
                <p>
                  When an API request arrives with a routed source model, 9Router transparently executes the target model instead. Token usage and costs are recorded against the target model. If the target provider fails (circuit open, quota exhausted, or 5xx errors), 9Router automatically falls back to executing the original source model.
                </p>
              </div>
            </div>
          </Card>
        </>
      )}

      {/* ── Aliases Tab ────────────────────────────────────────── */}
      {tab === "alias" && (
        <>
          {aliasEntries.length === 0 ? (
            <Card>
              <div className="py-12 text-center">
                <div className="mb-4 inline-flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary shadow-[var(--shadow-warm)]">
                  <span className="material-symbols-outlined text-[32px]">label</span>
                </div>
                <h3 className="mb-1 text-base font-semibold text-text-main">No model aliases configured</h3>
                <p className="mx-auto mb-5 max-w-md text-sm text-text-muted">
                  Create short, memorable aliases (e.g. <code className="font-mono text-xs">deepseek</code> &rarr; <code className="font-mono text-xs">wb/deepseek-v4.1-flash</code>) so you don&apos;t need to type full provider IDs.
                </p>
                <Button
                  icon="add"
                  onClick={() => {
                    setAliasError("");
                    setShowAddAliasModal(true);
                  }}
                >
                  Create First Alias
                </Button>
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {aliasEntries.map((item) => (
                <Card
                  key={item.name}
                  padding="sm"
                  className="group transition-all hover:border-brand-500/30"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="primary" size="md">
                          {item.name}
                        </Badge>
                        <span className="material-symbols-outlined text-[14px] text-text-muted">
                          arrow_forward
                        </span>
                        <code
                          className="max-w-[170px] truncate rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-main"
                          title={item.target}
                        >
                          {item.target}
                        </code>
                      </div>
                      <p className="mt-2 truncate text-[11px] text-text-muted">
                        Resolves to <code className="font-mono text-[10px] text-text-main">{item.target}</code>
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => copy(item.name, `alias-${item.name}`)}
                        className="rounded p-1 text-text-muted transition-colors hover:bg-surface-2 hover:text-primary"
                        title="Copy alias name"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {copied === `alias-${item.name}` ? "check" : "content_copy"}
                        </span>
                      </button>
                      <button
                        onClick={() => setPendingDeleteAlias(item.name)}
                        className="rounded p-1 text-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                        title="Delete alias"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                      </button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Modal: Create Route ───────────────────────────────── */}
      <Modal
        isOpen={showAddRouteModal}
        onClose={() => {
          setShowAddRouteModal(false);
          setRouteError("");
        }}
        title="Create Model Route"
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowAddRouteModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveRoute}
              disabled={saving}
              loading={saving}
              icon="alt_route"
            >
              {saving ? "Saving…" : "Save Route"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-main">
              Source Model <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <Input
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                placeholder="e.g. cmc/deepseek/deepseek-v4.1-flash"
                className="flex-1 font-mono text-xs"
              />
              <Button variant="secondary" onClick={() => setPickerFor("from")} title="Pick from available models">
                <span className="material-symbols-outlined text-[18px]">search</span>
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              The model ID clients or agents will send in requests.
            </p>
          </div>

          <div className="flex items-center justify-center py-0.5">
            <div className="h-px flex-1 bg-border-subtle" />
            <div className="mx-3 flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-2 px-3 py-1 font-mono text-xs text-text-muted">
              <span className="material-symbols-outlined text-[14px] text-primary">arrow_downward</span>
              <span>transparently executes</span>
            </div>
            <div className="h-px flex-1 bg-border-subtle" />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-main">
              Target Model <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <Input
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="e.g. wb/deepseek-v4.1-flash"
                className="flex-1 font-mono text-xs"
              />
              <Button variant="secondary" onClick={() => setPickerFor("to")} title="Pick from available models">
                <span className="material-symbols-outlined text-[18px]">search</span>
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              The model 9Router will actually run and record usage for.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 p-2.5 text-xs text-text-muted">
            <span className="material-symbols-outlined mt-0.5 shrink-0 text-[16px] text-primary">verified_user</span>
            <span>If the target model fails, 9Router automatically falls back to the original source model.</span>
          </div>

          {routeError && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {routeError}
            </p>
          )}
        </div>
      </Modal>

      {/* ── Modal: Create Alias ───────────────────────────────── */}
      <Modal
        isOpen={showAddAliasModal}
        onClose={() => {
          setShowAddAliasModal(false);
          setAliasError("");
        }}
        title="Create Model Alias"
        size="md"
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowAddAliasModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveAlias}
              disabled={saving}
              loading={saving}
              icon="label"
            >
              {saving ? "Saving…" : "Save Alias"}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-main">
              Alias Name <span className="text-red-500">*</span>
            </label>
            <Input
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              placeholder="e.g. deepseek"
              className="font-mono text-xs"
            />
            <p className="mt-1 text-[11px] text-text-muted">
              Short name without slashes (e.g. <code>deepseek</code>, <code>my-model</code>).
            </p>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-text-main">
              Target Model <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
              <Input
                value={aliasModel}
                onChange={(e) => setAliasModel(e.target.value)}
                placeholder="e.g. wb/deepseek-v4.1-flash"
                className="flex-1 font-mono text-xs"
              />
              <Button variant="secondary" onClick={() => setShowAliasPicker(true)} title="Pick from available models">
                <span className="material-symbols-outlined text-[18px]">search</span>
              </Button>
            </div>
            <p className="mt-1 text-[11px] text-text-muted">
              The model that will be called when using this alias.
            </p>
          </div>

          {aliasError && (
            <p className="flex items-center gap-1.5 text-xs text-red-500">
              <span className="material-symbols-outlined text-[14px]">error</span>
              {aliasError}
            </p>
          )}
        </div>
      </Modal>

      {/* Model Picker Modals */}
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
        modelAliases={aliases}
      />

      <ModelSelectModal
        isOpen={showAliasPicker}
        onClose={() => setShowAliasPicker(false)}
        onSelect={(m) => setAliasModel(m?.value || "")}
        activeProviders={activeProviders}
        title="Select Target Model"
        modelAliases={aliases}
      />

      {/* Confirm Deletion Modals */}
      <ConfirmModal
        isOpen={!!pendingDeleteRoute}
        onClose={() => setPendingDeleteRoute(null)}
        onConfirm={handleDeleteRoute}
        title="Delete route"
        message={`Delete route for "${pendingDeleteRoute}"?\n\nRequests will go directly to the original provider.`}
        confirmText="Delete"
      />

      <ConfirmModal
        isOpen={!!pendingDeleteAlias}
        onClose={() => setPendingDeleteAlias(null)}
        onConfirm={handleDeleteAlias}
        title="Delete alias"
        message={`Delete alias "${pendingDeleteAlias}"?`}
        confirmText="Delete"
      />
    </div>
  );
}

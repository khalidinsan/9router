"use client";

import PropTypes from "prop-types";
import Card from "@/shared/components/Card";
import { fmtTime } from "./UsageTable";
import { useClientTimeZone } from "@/shared/utils/datetime";

/**
 * Live "who is streaming right now" panel, per API key.
 * Fed by stats.activeByApiKey which the server pushes over SSE on every
 * pending change, so this updates in real time without a page refresh.
 */
export default function ActiveApiKeys({ active = [] }) {
  const tz = useClientTimeZone();
  const total = active.reduce((sum, a) => sum + (a.count || 0), 0);
  return (
    <Card className="overflow-hidden">
      <div className="p-4 border-b border-border bg-bg-subtle/50 flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2">
          <span className={`block w-2 h-2 rounded-full ${total > 0 ? "bg-success animate-pulse" : "bg-text-muted"}`} />
          Active Now
        </h3>
        <span className="text-xs text-text-muted">
          {total > 0 ? `${total} live request${total === 1 ? "" : "s"}` : "idle"}
        </span>
      </div>
      {active.length === 0 ? (
        <div className="px-6 py-5 text-sm text-text-muted">No active requests right now.</div>
      ) : (
        <div className="divide-y divide-border">
          {active.map((a) => (
            <div key={a.apiKeyMasked || a.keyName} className="px-6 py-3 flex items-center gap-3">
              <span className="block w-2 h-2 rounded-full bg-success animate-pulse shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-medium truncate">
                  {a.keyName}
                  {a.apiKeyMasked && (
                    <span className="ml-2 font-mono text-xs text-text-muted">{a.apiKeyMasked}</span>
                  )}
                </div>
                <div className="text-xs text-text-muted truncate" title={(a.models || []).map((m) => m.model).join(", ")}>
                  {(a.models || []).map((m) => `${m.model}${m.count > 1 ? ` ×${m.count}` : ""}`).join(" · ") || "—"}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-semibold text-primary">{a.count} live</div>
                <div className="text-[11px] text-text-muted whitespace-nowrap">seen {fmtTime(a.lastSeen, tz)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

ActiveApiKeys.propTypes = {
  active: PropTypes.arrayOf(PropTypes.shape({
    apiKeyMasked: PropTypes.string,
    keyName: PropTypes.string,
    count: PropTypes.number,
    models: PropTypes.array,
    lastSeen: PropTypes.string,
  })),
};

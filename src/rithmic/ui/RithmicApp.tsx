import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../../components/ui/button.tsx";
import { safeStorage } from "../../lib/safe-storage.ts";
import { Terminal } from "../../terminal/Terminal.tsx";
import { OpenChartsProvider } from "../../adapter/provider.tsx";
import { createRithmicAdapter, type RithmicAdapter } from "../adapter.ts";
import { getRithmicConfig, RITHMIC_GATEWAYS, type RithmicGateway } from "../config.ts";
import { listRithmicSystems } from "../connection.ts";
import { RithmicSession } from "../session.ts";

/**
 * The Rithmic app: a sign-in screen, then the terminal on a logged-in session.
 * This is what `Root` loads lazily when `VITE_ADAPTER=rithmic`.
 *
 * The password goes straight into the session's plant connections and is
 * never written anywhere; "remember me" keeps only gateway, system and user.
 */

const REMEMBER_KEY = "rithmic:signin";
const inputCls =
  "h-9 w-full rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface Remembered {
  gateway: string;
  systemName: string;
  user: string;
}

function loadRemembered(): Remembered | null {
  try {
    const raw = safeStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Remembered>;
    return typeof v.user === "string" ? { gateway: v.gateway ?? "", systemName: v.systemName ?? "", user: v.user } : null;
  } catch {
    return null;
  }
}

const config = getRithmicConfig();

function SignIn({ onSignedIn, notice }: { onSignedIn: (a: RithmicAdapter) => void; notice: string | null }) {
  const [remembered] = useState(loadRemembered);
  const [startGateway] = useState(() => remembered?.gateway || config.gateway);
  const [gateway, setGateway] = useState(startGateway);
  const [systems, setSystems] = useState<string[]>(remembered?.systemName ? [remembered.systemName] : []);
  const [systemName, setSystemName] = useState(remembered?.systemName ?? "");
  const [user, setUser] = useState(remembered?.user ?? "");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(remembered !== null);
  const [loadingSystems, setLoadingSystems] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(notice);

  // A gateway outside the published list (remembered, or VITE_RITHMIC_GATEWAY) stays selectable.
  const [gatewayOptions] = useState<readonly RithmicGateway[]>(() =>
    RITHMIC_GATEWAYS.some((g) => g.url === startGateway)
      ? RITHMIC_GATEWAYS
      : [{ name: `Custom (${startGateway})`, url: startGateway }, ...RITHMIC_GATEWAYS],
  );
  // Only the latest system-list request may update the form.
  const loadSeq = useRef(0);

  const loadSystems = useCallback(async (url: string) => {
    const seq = ++loadSeq.current;
    setLoadingSystems(true);
    setError(null);
    try {
      const list = await listRithmicSystems(url);
      if (seq !== loadSeq.current) return;
      setSystems(list);
      setSystemName((cur) => (cur && list.includes(cur) ? cur : (list[0] ?? "")));
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeq.current) setLoadingSystems(false);
    }
  }, []);

  const pickGateway = (url: string) => {
    setGateway(url);
    // Systems belong to a gateway: drop the old list so a failed load leaves none.
    setSystems([]);
    setSystemName("");
    void loadSystems(url);
  };

  // Fill the system list once on mount; picking another gateway reloads it.
  useEffect(() => {
    const t = setTimeout(() => void loadSystems(startGateway), 0);
    return () => clearTimeout(t);
  }, [loadSystems, startGateway]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !password || !systemName) {
      setError("Enter the system, user and password.");
      return;
    }
    setSigningIn(true);
    setError(null);
    const session = new RithmicSession({
      config,
      gateway,
      credentials: { user, password, systemName },
    });
    try {
      await session.connect();
    } catch (err) {
      session.dispose();
      setError(err instanceof Error ? err.message : String(err));
      setSigningIn(false);
      return;
    }
    if (remember) safeStorage.setItem(REMEMBER_KEY, JSON.stringify({ gateway, systemName, user }));
    else safeStorage.removeItem(REMEMBER_KEY);
    setPassword("");
    onSignedIn(createRithmicAdapter({ session, products: config.products }));
  };

  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-4 text-foreground">
      <form onSubmit={(e) => void submit(e)} className="w-full max-w-sm space-y-4 rounded-lg border border-border bg-card p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold">Sign in to Rithmic</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Your password is sent only to the Rithmic gateway and is never stored.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Gateway</span>
          <select className={inputCls} value={gateway} onChange={(e) => pickGateway(e.target.value)} disabled={signingIn}>
            {gatewayOptions.map((g) => (
              <option key={g.url} value={g.url}>
                {g.name}
              </option>
            ))}
          </select>
          <span className="block truncate text-[10px] text-muted-foreground">{gateway}</span>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">System</span>
          <select className={inputCls} value={systemName} onChange={(e) => setSystemName(e.target.value)} disabled={systems.length === 0}>
            {systems.length === 0 && <option value="">No systems loaded</option>}
            {systems.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">User</span>
          <input className={inputCls} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" spellCheck={false} />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Password</span>
          <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember gateway, system and user on this device
        </label>

        {error && (
          <p role="alert" className="break-words rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <Button type="submit" className="w-full" loading={signingIn} disabled={signingIn || loadingSystems}>
          Sign in
        </Button>
      </form>
    </div>
  );
}

function SessionBar({ adapter, onSignOut }: { adapter: RithmicAdapter; onSignOut: () => void }) {
  const [state, setState] = useState(adapter.session.getState());
  useEffect(() => {
    const offs = adapter.session.plants().map((p) => p.onState(() => setState(adapter.session.getState())));
    return () => offs.forEach((off) => off());
  }, [adapter]);
  const dot = state === "connected" ? "bg-success" : state === "disconnected" ? "bg-destructive" : "bg-warning";
  return (
    <div className="flex h-7 shrink-0 items-center gap-3 border-b border-border bg-card px-3 text-[11px] text-muted-foreground">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      <span className="font-medium text-foreground">Rithmic</span>
      <span>{adapter.session.systemName}</span>
      <span>{adapter.session.user}</span>
      <span className="capitalize">{state}</span>
      <button type="button" className="ml-auto rounded px-2 py-0.5 hover:bg-secondary hover:text-foreground" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

/**
 * Every stylesheet rule is scoped under `.opencharts` (see postcss.config.js),
 * which only `<OpenChartsProvider>` renders. The sign-in screen and session bar
 * sit outside the provider, so they need their own scope root.
 */
function Scope({ children }: { children: ReactNode }) {
  return (
    <div className="opencharts" style={{ position: "relative", height: "100%", width: "100%" }}>
      {children}
    </div>
  );
}

export default function RithmicApp() {
  const [adapter, setAdapter] = useState<RithmicAdapter | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Logging out happens on an explicit sign-out or a fatal session error, never
  // in an effect cleanup: StrictMode rehearses unmounts and would end the session.
  const signOut = useCallback((a: RithmicAdapter, message: string | null) => {
    a.dispose();
    setNotice(message);
    setAdapter(null);
  }, []);

  useEffect(() => {
    if (!adapter) return;
    return adapter.session.onFatal((err) => signOut(adapter, err.message));
  }, [adapter, signOut]);

  useEffect(() => {
    if (!adapter) return;
    const onPageHide = () => adapter.dispose();
    window.addEventListener("pagehide", onPageHide);
    return () => window.removeEventListener("pagehide", onPageHide);
  }, [adapter]);

  if (!adapter) {
    return (
      <Scope>
        <SignIn
          notice={notice}
          onSignedIn={(a) => {
            setNotice(null);
            setAdapter(a);
          }}
        />
      </Scope>
    );
  }
  return (
    <Scope>
      <div className="flex h-full w-full flex-col">
        <SessionBar adapter={adapter} onSignOut={() => signOut(adapter, null)} />
        <div className="min-h-0 flex-1">
          <OpenChartsProvider adapter={adapter}>
            <Terminal />
          </OpenChartsProvider>
        </div>
      </div>
    </Scope>
  );
}

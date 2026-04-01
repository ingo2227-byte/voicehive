"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { parseVoiceText } from "@/lib/voice-parser";
import { getMissingQuestions, type RequiredSettings } from "@/lib/clarify";
import {
  addPendingAction,
  createActionId,
  type HiveInput,
} from "@/lib/offline-queue";
import { useOfflineSync } from "@/hooks/use-offline-sync";
import { Toast, type ToastMessage, type ToastTone } from "@/components/ui/toast";

type HiveListItem = {
  id: string;
  name: string;
  location: string | null;
  createdAt: string;
  updatedAt: string;
  latestInspection: {
    id: string;
    inspectedAt: string;
    broodFrames: number | null;
    honeyFrames: number | null;
    queenSeen: boolean | null;
    temperament: string | null;
    notes: string | null;
  } | null;
};

type FormState = {
  id: string;
  name: string;
  location: string;
  inspectedAt: string;
  broodFrames: string;
  honeyFrames: string;
  queenSeen: "unknown" | "yes" | "no";
  temperament: string;
  notes: string;
};

type ParsedPreview = ReturnType<typeof parseVoiceText>;

type SpeechRecognitionResultLike = {
  0: {
    transcript: string;
  };
};

type SpeechRecognitionEventLike = Event & {
  results: {
    0: SpeechRecognitionResultLike;
  };
};

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    SpeechRecognition?: SpeechRecognitionConstructor;
  }
}

const initialForm: FormState = {
  id: "",
  name: "",
  location: "",
  inspectedAt: "",
  broodFrames: "",
  honeyFrames: "",
  queenSeen: "unknown",
  temperament: "ruhig",
  notes: "",
};

const requiredSettings: RequiredSettings = {
  requireQueenSeen: true,
  requireBroodFrames: false,
  requireHoneyFrames: false,
  requireTemperament: false,
  requireNotes: false,
};

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("de-DE");
}

export default function Home() {
  const [voiceText, setVoiceText] = useState("");
  const [isListening, setIsListening] = useState(false);
  const [hives, setHives] = useState<HiveListItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const [preview, setPreview] = useState<ParsedPreview | null>(null);
  const [missingQuestions, setMissingQuestions] = useState<string[]>([]);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  const { isOnline, pendingCount, isSyncing, manualSync, refreshPendingCount } =
    useOfflineSync();

  const totalHives = hives.length;
  const latestInspectionDate = useMemo(() => {
    const latest = hives
      .map((hive) => hive.latestInspection?.inspectedAt)
      .filter(Boolean)
      .sort()
      .at(-1);

    return latest ? formatDate(latest) : "—";
  }, [hives]);

  const pushToast = useCallback((text: string, tone: ToastTone = "info") => {
    setToast({ id: Date.now(), text, tone });
  }, []);

  async function loadHives() {
    try {
      setIsLoading(true);
      const res = await fetch("/api/voelker", { cache: "no-store" });
      const data = await res.json();

      if (!res.ok) {
        pushToast(data.error || "Völker konnten nicht geladen werden.", "error");
        return;
      }

      setHives(data);
    } catch {
      pushToast("Völker konnten nicht geladen werden.", "error");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadHives();
  }, []);

  function buildPayload(): HiveInput {
    return {
      name: form.name.trim(),
      location: form.location.trim() || undefined,
      inspectedAt: form.inspectedAt || new Date().toISOString(),
      broodFrames: form.broodFrames ? Number(form.broodFrames) : undefined,
      honeyFrames: form.honeyFrames ? Number(form.honeyFrames) : undefined,
      queenSeen:
        form.queenSeen === "unknown" ? undefined : form.queenSeen === "yes",
      temperament: form.temperament || undefined,
      notes: form.notes.trim() || undefined,
    };
  }

  function applyVoicePreview(parsed: ParsedPreview) {
    setForm((prev) => ({
      ...prev,
      name: parsed.name ?? prev.name,
      location: parsed.location ?? prev.location,
      inspectedAt: parsed.inspectedAt ?? prev.inspectedAt,
      broodFrames:
        parsed.broodFrames !== undefined ? String(parsed.broodFrames) : prev.broodFrames,
      honeyFrames:
        parsed.honeyFrames !== undefined ? String(parsed.honeyFrames) : prev.honeyFrames,
      queenSeen:
        parsed.queenSeen === undefined
          ? prev.queenSeen
          : parsed.queenSeen
          ? "yes"
          : "no",
      temperament: parsed.temperament ?? prev.temperament,
      notes: parsed.notes ?? prev.notes,
    }));

    setPreview(parsed);
    setMissingQuestions(
      getMissingQuestions(
        {
          queenSeen: parsed.queenSeen,
          broodFrames: parsed.broodFrames,
          honeyFrames: parsed.honeyFrames,
          temperament: parsed.temperament,
          notes: parsed.notes,
        },
        requiredSettings
      )
    );
  }

  function handleVoiceEvaluation() {
    if (!voiceText.trim()) {
      pushToast("Bitte zuerst etwas sprechen oder eingeben.", "error");
      return;
    }

    const parsed = parseVoiceText(voiceText);
    applyVoicePreview(parsed);
    pushToast("Sprachtext analysiert. Prüfe den Vorschlag unten.", "success");

    if (!navigator.onLine) {
      addPendingAction({
        id: createActionId(),
        type: "create",
        payload: {
          name: parsed.name || "Neues Volk",
          location: parsed.location || undefined,
          inspectedAt: parsed.inspectedAt || new Date().toISOString(),
          broodFrames: parsed.broodFrames,
          honeyFrames: parsed.honeyFrames,
          queenSeen: parsed.queenSeen,
          temperament: parsed.temperament,
          notes: parsed.notes || voiceText,
        },
        createdAt: Date.now(),
      });

      refreshPendingCount();
      pushToast("Offline gespeichert. Wird später synchronisiert.", "info");
    }
  }

  function startMic() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!Recognition) {
      pushToast("Spracherkennung wird in diesem Browser nicht unterstützt.", "error");
      return;
    }

    const recognition = new Recognition();
    recognition.lang = "de-DE";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event: SpeechRecognitionEventLike) => {
  setVoiceText(event.results[0][0].transcript);
};
    recognition.onerror = () => {
      setIsListening(false);
      pushToast("Spracherkennung fehlgeschlagen.", "error");
    };
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopMic() {
    recognitionRef.current?.stop();
    setIsListening(false);
  }

  async function save(e: FormEvent) {
    e.preventDefault();

    if (!form.name.trim()) {
      pushToast("Bitte einen Volk-Namen eingeben.", "error");
      return;
    }

    const payload = buildPayload();
    setIsSaving(true);

    try {
      const res = await fetch(
        isEditing ? `/api/voelker/${form.id}` : "/api/voelker",
        {
          method: isEditing ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Speichern fehlgeschlagen.");
      }

      setForm(initialForm);
      setVoiceText("");
      setPreview(null);
      setMissingQuestions([]);
      setIsEditing(false);
      await loadHives();
      refreshPendingCount();
      pushToast("Gespeichert.", "success");
 finally {
      setIsSaving(false);
    }
  }} catch {
  if (isEditing) {
    addPendingAction({
      id: createActionId(),
      type: "update",
      hiveId: form.id,
      payload,
      createdAt: Date.now(),
    });
  } else {
    addPendingAction({
      id: createActionId(),
      type: "create",
      payload,
      createdAt: Date.now(),
    });
  }

  setForm(initialForm);
  setVoiceText("");
  setIsEditing(false);
  refreshPendingCount();
  pushToast("Offline gespeichert. Wird später synchronisiert.", "warning");
}

  function editHive(hive: HiveListItem) {
    const latest = hive.latestInspection;

    setForm({
      id: hive.id,
      name: hive.name,
      location: hive.location ?? "",
      inspectedAt: latest?.inspectedAt?.slice(0, 10) ?? "",
      broodFrames: latest?.broodFrames?.toString() ?? "",
      honeyFrames: latest?.honeyFrames?.toString() ?? "",
      queenSeen:
        latest?.queenSeen === true ? "yes" : latest?.queenSeen === false ? "no" : "unknown",
      temperament: latest?.temperament ?? "ruhig",
      notes: latest?.notes ?? "",
    });

    setIsEditing(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteHive(id: string) {
    const confirmed = window.confirm("Dieses Volk wirklich löschen?");
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/voelker/${id}`, { method: "DELETE" });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Löschen fehlgeschlagen.");
      }

      await loadHives();
      pushToast("Volk gelöscht.", "success");
    } catch {
      addPendingAction({
        id: createActionId(),
        type: "delete",
        hiveId: id,
        createdAt: Date.now(),
      });

      refreshPendingCount();
      setHives((prev) => prev.filter((item) => item.id !== id));
      pushToast("Löschvorgang offline vorgemerkt.", "info");
    }
  }

  return (
    <main style={pageStyle}>
      <Toast message={toast} onDismiss={() => setToast(null)} />

      <section style={heroStyle}>
        <div>
          <p style={eyebrowStyle}>VoiceHive</p>
          <h1 style={titleStyle}>Digitale Stockkarte mit Spracheingabe und Offline-Sync</h1>
          <p style={subtitleStyle}>
            Erfasse Durchsichten schneller, halte Völker sauber dokumentiert und
            synchronisiere Änderungen automatisch, sobald wieder Verbindung besteht.
          </p>
        </div>

        <div style={statsGridStyle}>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>Völker</span>
            <strong style={statValueStyle}>{totalHives}</strong>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>Letzte Durchsicht</span>
            <strong style={statValueStyle}>{latestInspectionDate}</strong>
          </div>
          <div style={statCardStyle}>
            <span style={statLabelStyle}>Sync-Status</span>
            <strong style={statValueStyle}>{isOnline ? "Online" : "Offline"}</strong>
          </div>
        </div>
      </section>

      <section style={toolbarStyle}>
        <div>
          <strong>{isOnline ? "Online" : "Offline"}</strong>
          <span style={{ marginLeft: 8 }}>
            {pendingCount > 0
              ? `${pendingCount} ausstehende Änderung(en)`
              : "Keine ausstehenden Änderungen"}
          </span>
        </div>

        {pendingCount > 0 ? (
          <button
            type="button"
            onClick={async () => {
              const result = await manualSync();
              if (result) {
                pushToast(
                  `${result.synced} synchronisiert, ${result.failed} fehlgeschlagen.`,
                  result.failed > 0 ? "info" : "success"
                );
                await loadHives();
              }
            }}
            disabled={!isOnline || isSyncing}
            style={primaryButtonStyle}
          >
            {isSyncing ? "Synchronisiere..." : "Jetzt synchronisieren"}
          </button>
        ) : null}
      </section>

      <section style={gridStyle}>
        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>Spracheingabe</h2>
          <textarea
            value={voiceText}
            onChange={(e) => setVoiceText(e.target.value)}
            placeholder='Beispiel: "Volk 3, Stand Obstwiese, heute, 5 Brutwaben, Königin gesehen, ruhig"'
            style={textareaStyle}
          />
          <div style={buttonRowStyle}>
            <button type="button" onClick={startMic} style={primaryButtonStyle}>
              {isListening ? "🎙️ Hört zu..." : "🎤 Mikrofon starten"}
            </button>
            <button type="button" onClick={stopMic} style={secondaryButtonStyle}>
              Stoppen
            </button>
            <button type="button" onClick={handleVoiceEvaluation} style={secondaryButtonStyle}>
              Vorschlag erzeugen
            </button>
          </div>

          {preview ? (
            <div style={previewCardStyle}>
              <h3 style={{ marginTop: 0 }}>Parser-Vorschlag</h3>
              <div style={previewGridStyle}>
                <div><strong>Volk:</strong> {preview.name || "—"}</div>
                <div><strong>Standort:</strong> {preview.location || "—"}</div>
                <div><strong>Datum:</strong> {preview.inspectedAt || "—"}</div>
                <div><strong>Brutwaben:</strong> {preview.broodFrames ?? "—"}</div>
                <div><strong>Honigwaben:</strong> {preview.honeyFrames ?? "—"}</div>
                <div>
                  <strong>Königin:</strong>{" "}
                  {preview.queenSeen === true ? "gesehen" : preview.queenSeen === false ? "nicht gesehen" : "—"}
                </div>
                <div><strong>Verhalten:</strong> {preview.temperament || "—"}</div>
              </div>
              {missingQuestions.length > 0 ? (
                <div style={questionBoxStyle}>
                  <strong>Es fehlen noch Angaben:</strong>
                  <ul style={{ marginBottom: 0 }}>
                    {missingQuestions.map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <div style={panelStyle}>
          <h2 style={panelTitleStyle}>{isEditing ? "Durchsicht ergänzen" : "Neue Durchsicht"}</h2>

          <form onSubmit={save} style={formStyle}>
            <div style={twoColStyle}>
              <input
                style={inputStyle}
                placeholder="Volkname"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
              <input
                style={inputStyle}
                placeholder="Standort"
                value={form.location}
                onChange={(e) => setForm((prev) => ({ ...prev, location: e.target.value }))}
              />
            </div>

            <input
              type="date"
              style={inputStyle}
              value={form.inspectedAt}
              onChange={(e) => setForm((prev) => ({ ...prev, inspectedAt: e.target.value }))}
            />

            <div style={twoColStyle}>
              <input
                style={inputStyle}
                placeholder="Brutwaben"
                value={form.broodFrames}
                onChange={(e) => setForm((prev) => ({ ...prev, broodFrames: e.target.value }))}
              />
              <input
                style={inputStyle}
                placeholder="Honigwaben"
                value={form.honeyFrames}
                onChange={(e) => setForm((prev) => ({ ...prev, honeyFrames: e.target.value }))}
              />
            </div>

            <select
              style={inputStyle}
              value={form.queenSeen}
              onChange={(e) =>
                setForm((prev) => ({
                  ...prev,
                  queenSeen: e.target.value as FormState["queenSeen"],
                }))
              }
            >
              <option value="unknown">Königin unbekannt</option>
              <option value="yes">Königin gesehen</option>
              <option value="no">Königin nicht gesehen</option>
            </select>

            <select
              style={inputStyle}
              value={form.temperament}
              onChange={(e) => setForm((prev) => ({ ...prev, temperament: e.target.value }))}
            >
              <option value="ruhig">ruhig</option>
              <option value="leicht nervös">leicht nervös</option>
              <option value="nervös">nervös</option>
              <option value="aggressiv">aggressiv</option>
            </select>

            <textarea
              style={textareaSmallStyle}
              placeholder="Notiz zur Durchsicht"
              value={form.notes}
              onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
            />

            <div style={buttonRowStyle}>
              <button type="submit" style={primaryButtonStyle} disabled={isSaving}>
                {isSaving ? "Speichert..." : isEditing ? "Durchsicht speichern" : "Volk anlegen"}
              </button>

              {isEditing ? (
                <button
                  type="button"
                  style={secondaryButtonStyle}
                  onClick={() => {
                    setForm(initialForm);
                    setIsEditing(false);
                    setPreview(null);
                    setMissingQuestions([]);
                  }}
                >
                  Abbrechen
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </section>

      <section style={panelStyle}>
        <div style={listHeaderStyle}>
          <h2 style={panelTitleStyle}>Deine Völker</h2>
          <span style={listMetaStyle}>{totalHives} Einträge</span>
        </div>

        {isLoading ? (
          <p>Lade Völker...</p>
        ) : hives.length === 0 ? (
          <div style={emptyStateStyle}>
            <strong>🐝 Noch keine Völker vorhanden</strong>
            <p style={{ margin: 0 }}>Lege dein erstes Volk an oder nutze die Spracheingabe.</p>
          </div>
        ) : (
          <div style={listStyle}>
            {hives.map((hive) => (
              <article key={hive.id} style={hiveCardStyle}>
                <div>
                  <h3 style={hiveTitleStyle}>{hive.name}</h3>
                  <p style={hiveMetaStyle}>Standort: {hive.location || "—"}</p>
                  <p style={hiveMetaStyle}>
                    Letzte Durchsicht: {formatDate(hive.latestInspection?.inspectedAt)}
                  </p>
                </div>

                <div style={inspectionInfoStyle}>
                  <span>Brut: {hive.latestInspection?.broodFrames ?? "—"}</span>
                  <span>Honig: {hive.latestInspection?.honeyFrames ?? "—"}</span>
                  <span>
                    Königin:{" "}
                    {hive.latestInspection?.queenSeen === true
                      ? "ja"
                      : hive.latestInspection?.queenSeen === false
                      ? "nein"
                      : "—"}
                  </span>
                </div>

                <div style={buttonRowStyle}>
                  <button type="button" style={secondaryButtonStyle} onClick={() => editHive(hive)}>
                    Bearbeiten
                  </button>
                  <a href={`/volk/${hive.id}`} style={linkButtonStyle}>
                    Verlauf
                  </a>
                  <button type="button" style={dangerButtonStyle} onClick={() => deleteHive(hive.id)}>
                    Löschen
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

const pageStyle: CSSProperties = {
  maxWidth: 1180,
  margin: "0 auto",
  padding: "32px 20px 64px",
  display: "grid",
  gap: 24,
};

const heroStyle: CSSProperties = {
  display: "grid",
  gap: 20,
  padding: 28,
  borderRadius: 24,
  background: "linear-gradient(135deg, #fff7ed 0%, #fefce8 100%)",
  border: "1px solid #fde68a",
};

const eyebrowStyle: CSSProperties = {
  margin: 0,
  color: "#92400e",
  fontWeight: 700,
  fontSize: 14,
  textTransform: "uppercase",
  letterSpacing: 0.8,
};

const titleStyle: CSSProperties = {
  margin: "8px 0 10px",
  fontSize: 38,
  lineHeight: 1.1,
};

const subtitleStyle: CSSProperties = {
  margin: 0,
  color: "#444",
  maxWidth: 760,
  fontSize: 17,
  lineHeight: 1.6,
};

const statsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: 14,
};

const statCardStyle: CSSProperties = {
  borderRadius: 18,
  background: "#fff",
  border: "1px solid #f3f4f6",
  padding: 18,
  boxShadow: "0 8px 24px rgba(0,0,0,0.04)",
};

const statLabelStyle: CSSProperties = {
  display: "block",
  fontSize: 13,
  color: "#666",
  marginBottom: 6,
};

const statValueStyle: CSSProperties = {
  fontSize: 22,
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  flexWrap: "wrap",
  padding: 16,
  borderRadius: 16,
  background: "#ecfdf5",
  border: "1px solid #a7f3d0",
};

const gridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1.1fr 1fr",
  gap: 24,
};

const panelStyle: CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 22,
  padding: 24,
  boxShadow: "0 10px 30px rgba(0,0,0,0.04)",
};

const panelTitleStyle: CSSProperties = {
  marginTop: 0,
  marginBottom: 16,
  fontSize: 22,
};

const formStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const twoColStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 12,
};

const inputStyle: CSSProperties = {
  width: "100%",
  borderRadius: 14,
  border: "1px solid #d1d5db",
  padding: "12px 14px",
  fontSize: 15,
  background: "#fff",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 150,
  resize: "vertical",
};

const textareaSmallStyle: CSSProperties = {
  ...inputStyle,
  minHeight: 110,
  resize: "vertical",
};

const buttonRowStyle: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
};

const primaryButtonStyle: CSSProperties = {
  border: "none",
  borderRadius: 12,
  padding: "12px 16px",
  background: "#111827",
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
};

const secondaryButtonStyle: CSSProperties = {
  border: "1px solid #d1d5db",
  borderRadius: 12,
  padding: "12px 16px",
  background: "#fff",
  color: "#111827",
  fontWeight: 600,
  cursor: "pointer",
};

const dangerButtonStyle: CSSProperties = {
  border: "1px solid #fecaca",
  borderRadius: 12,
  padding: "12px 16px",
  background: "#fff1f2",
  color: "#b91c1c",
  fontWeight: 700,
  cursor: "pointer",
};

const linkButtonStyle: CSSProperties = {
  ...secondaryButtonStyle,
  textDecoration: "none",
  display: "inline-block",
};

const listHeaderStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 18,
};

const listMetaStyle: CSSProperties = {
  color: "#666",
  fontSize: 14,
};

const listStyle: CSSProperties = {
  display: "grid",
  gap: 14,
};

const hiveCardStyle: CSSProperties = {
  border: "1px solid #e5e7eb",
  borderRadius: 18,
  padding: 18,
  display: "grid",
  gap: 14,
};

const hiveTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
};

const hiveMetaStyle: CSSProperties = {
  margin: "6px 0 0",
  color: "#555",
};

const inspectionInfoStyle: CSSProperties = {
  display: "flex",
  gap: 16,
  flexWrap: "wrap",
  color: "#374151",
  fontSize: 14,
};

const previewCardStyle: CSSProperties = {
  marginTop: 18,
  borderRadius: 16,
  border: "1px solid #fde68a",
  background: "#fffbeb",
  padding: 16,
};

const previewGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 10,
};

const questionBoxStyle: CSSProperties = {
  marginTop: 14,
  borderTop: "1px solid #fcd34d",
  paddingTop: 12,
};

const emptyStateStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: 20,
  borderRadius: 18,
  background: "#fffbeb",
  border: "1px dashed #f59e0b",
};

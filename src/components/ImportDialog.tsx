import { useState } from "react";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, LogBox, Spinner, Textarea } from "./ui";
import { api, asAppError, type ImportReport } from "../lib/api";

export function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: () => void;
}) {
  const [text, setText] = useState("");
  const [prefix, setPrefix] = useState("Wallet");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  // Mirrors the Rust splitter: newlines, commas and spaces all separate keys,
  // except inside [...] so a JSON byte array counts as one entry.
  const entryCount = (() => {
    const body = text
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith("#") && !t.startsWith("//");
      })
      .join("\n");
    const arrays = body.match(/\[[^\]]*\]/g)?.length ?? 0;
    const rest = body.replace(/\[[^\]]*\]/g, " ");
    const singles = rest.split(/[,\s]+/).filter((e) => e.length > 0).length;
    return arrays + singles;
  })();

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.walletsImport(text, prefix.trim() || "Wallet");
      setReport(result);
      setText("");
      onImported();
    } catch (e) {
      setError(asAppError(e).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Import wallets"
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <span className="flex-1 text-xs text-mist-500">
            {entryCount > 0 && `${entryCount} key${entryCount === 1 ? "" : "s"} detected`}
          </span>
          <Button onClick={onClose} disabled={busy}>
            {report ? "Done" : "Cancel"}
          </Button>
          <Button variant="primary" onClick={run} disabled={busy || text.trim().length === 0}>
            {busy && <Spinner />}
            {busy ? "Importing…" : "Import"}
          </Button>
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}

      {report && (
        <Banner kind={report.failed.length > 0 ? "warning" : "success"}>
          Imported {report.imported}. {report.duplicates} duplicate
          {report.duplicates === 1 ? "" : "s"} skipped. {report.failed.length} failed.
        </Banner>
      )}

      {report && report.failed.length > 0 && (
        <div className="mb-4">
          <LogBox>
            {report.failed.map((f, i) => (
              <div key={i} className="flex items-baseline gap-2 py-0.5">
                <span className="text-mist-500">line {f.line}</span>
                <span className="min-w-0 flex-1 truncate">{f.preview}</span>
                <span className="text-rose-400">{f.message}</span>
              </div>
            ))}
          </LogBox>
        </div>
      )}

      <Field
        label="Label prefix"
        hint={`Wallets are named "${prefix || "Wallet"} 1", "${prefix || "Wallet"} 2", … and can be renamed later.`}
      >
        <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
      </Field>

      <Field
        label="Private keys"
        hint="Separators: newline, comma or space — a single comma-separated line of base58 keys works. Keys are encrypted into the vault immediately and never leave this machine."
      >
        <Textarea
          className="min-h-56"
          value={text}
          placeholder={
            "Paste one key per line, or many separated by commas.\n\n" +
            "4NMwxzmb…            base58 secret key (Phantom)\n" +
            "[12,34,56,…]          id.json byte array\n" +
            "keyA, keyB, keyC     comma-separated, all on one line\n\n" +
            "Formats can be mixed. Lines starting with # are ignored."
          }
          onChange={(e) => setText(e.target.value)}
        />
      </Field>
    </Modal>
  );
}

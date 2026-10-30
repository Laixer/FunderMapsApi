import { describe, expect, test } from "bun:test";
import { AppError } from "./errors.ts";
import { INTAKE_PREFIX, MAX_UPLOAD_BYTES, planUpload, toDossierInput } from "./submission-rules.ts";

const code = (f: () => unknown) => {
  try { f(); return 200; } catch (e) { return e instanceof AppError ? `${e.statusCode} ${e.message}` : String(e); }
};
const SOURCE = { ip: "1.2.3.4", agent: "Mozilla/5.0", referrer: "https://melden.fundermaps.com/form/x" };
const form = (over: Record<string, unknown> = {}) => ({
  address: { bagId: "0363200000123456", label: "Damrak 1, Amsterdam" },
  topic: "foundationType",
  topicLabel: "Het funderingstype klopt niet",
  answers: { since: "2020", count: 3 },
  attachments: [{ key: `${INTAKE_PREFIX}aaa.pdf`, name: "rapport.pdf", size: 1234, category: "foundation_research" }],
  contact: { type: "owner", name: "Piet", email: " piet@example.test ", phone: "0612345678" },
  owner: true,
  note: "Zie bijlage",
  formVersion: "2026-10",
  submissionId: "sub-1",
  ...over,
});

describe("planUpload", () => {
  test("one generated key under intake/, the extension from the type", () => {
    const p = planUpload({ name: "../../etc/passwd.pdf", size: 1000, type: "application/pdf" }, () => "u1");
    expect(p).toEqual({ key: "intake/u1.pdf", type: "application/pdf", size: 1000 });
  });
  test("a phone's HEIC without a type keeps its own extension", () => {
    expect(planUpload({ name: "IMG_0001.HEIC", size: 10, type: "application/octet-stream" }, () => "u2").key).toBe("intake/u2.heic");
    expect(planUpload({ name: "weird.name.???", size: 10, type: "application/octet-stream" }, () => "u3").key).toBe("intake/u3.bin");
  });
  test("empty, too big, or an unsupported type: refused in Dutch", () => {
    expect(code(() => planUpload({ size: 0, type: "application/pdf" }))).toBe("400 Bestand is te groot of leeg");
    expect(code(() => planUpload({ size: MAX_UPLOAD_BYTES + 1, type: "application/pdf" }))).toBe("400 Bestand is te groot of leeg");
    expect(code(() => planUpload({ size: 10, type: "text/html" }))).toBe("400 Bestandstype wordt niet ondersteund");
  });
});

describe("toDossierInput", () => {
  test("the form as the dossier input, with where it came from", () => {
    const d = toDossierInput(form(), SOURCE);
    expect(d.building).toBe("0363200000123456");
    expect(d.contact.email).toBe("piet@example.test");
    expect(d.answers).toEqual({ since: "2020", count: "3" });
    expect(d.attachments).toEqual([{ key: "intake/aaa.pdf", name: "rapport.pdf", size: 1234, category: "foundation_research" }]);
    expect(d.source).toMatchObject({ submission: "sub-1", address: "Damrak 1, Amsterdam", ip: "1.2.3.4" });
  });
  test("both BAG id formats are accepted", () => {
    expect(code(() => toDossierInput(form({ address: { bagId: "NL.IMBAG.NUMMERAANDUIDING.0363200000123456" } }), SOURCE))).toBe(200);
  });
  test("no address, no topic, no e-mail address: each refused in Dutch", () => {
    expect(code(() => toDossierInput(form({ address: { bagId: "Damrak 1" } }), SOURCE))).toBe("400 Geen geldig adres gekozen");
    expect(code(() => toDossierInput(form({ topic: "" }), SOURCE))).toBe("400 Geen onderwerp gekozen");
    expect(code(() => toDossierInput(form({ contact: { email: "piet" } }), SOURCE))).toBe("400 Geen geldig e-mailadres");
  });
  test("an attachment outside intake/ is refused: someone else's evidence cannot be attached", () => {
    expect(code(() => toDossierInput(form({ attachments: [{ key: "inquiry-report/abc.pdf" }] }), SOURCE))).toBe("400 Ongeldige bijlage");
    expect(code(() => toDossierInput(form({ attachments: [{ key: "intake/../inquiry-report/abc.pdf" }] }), SOURCE))).toBe("400 Ongeldige bijlage");
  });
  test("at most ten attachments are taken", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `intake/${i}.pdf` }));
    expect(toDossierInput(form({ attachments: many }), SOURCE).attachments).toHaveLength(10);
  });
});

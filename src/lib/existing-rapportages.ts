import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";

/**
 * Rapportages already on a dossier's pand, for the warning before
 * "Overnemen als rapportage".
 *
 * Molenwal 15 (Don, 2026-10-08) had the same BVLB survey five times: once
 * through the nalezing, three times committed from meldingen, once more by
 * hand. Since 2026-09-01, 159 committed rapportages repeated one that was
 * already there; 51 of them carried the very same file. Nothing at commit time
 * said so. This list lets the Studio say it, and the rule for which copy to
 * keep is Don's: the most complete one, most addresses and most samples.
 *
 * "Same file" compares byte size with the dossier's own documents. The commit
 * copies a document into inquiry-report/ unchanged and records its size in
 * application.file_resources, so a recommitted file matches exactly. A
 * re-compressed copy of the same report does not; that is what the type and
 * date in the Studio are for. Rapportages from before file_resources existed
 * (Laixer/FunderMaps#861) have no size and never count as the same file.
 */
export interface ExistingRapportage {
  id: number;
  type: string;
  documentDate: string | null;
  documentName: string | null;
  auditStatus: string;
  addresses: number;
  samples: number;
  sameFile: boolean;
}

interface Row {
  id: number;
  type: string;
  document_date: string | null;
  document_name: string | null;
  audit_status: string;
  size_bytes: number | string | null;
  addresses: number | string;
  samples: number | string;
}

/** Marks the rows whose file has the same size as one of the dossier's documents. Pure, for the tests. */
export function markSameFile(rows: Row[], documentSizes: (number | null | undefined)[]): ExistingRapportage[] {
  const sizes = new Set(documentSizes.filter((s): s is number => typeof s === "number" && s > 0));
  return rows.map((r) => {
    const size = r.size_bytes == null ? null : Number(r.size_bytes);
    return {
      id: Number(r.id),
      type: r.type,
      documentDate: r.document_date,
      documentName: r.document_name,
      auditStatus: r.audit_status,
      addresses: Number(r.addresses),
      samples: Number(r.samples),
      sameFile: size != null && size > 0 && sizes.has(size),
    };
  });
}

/**
 * Live rapportages with at least one live sample on the pand, newest document
 * first. `exceptInquiryId` leaves out the rapportage the dossier itself became.
 */
export async function existingRapportages(
  buildingId: string,
  documentSizes: (number | null | undefined)[],
  exceptInquiryId: number | null = null,
): Promise<ExistingRapportage[]> {
  const rows = (await db.execute(sql`
    SELECT i.id,
           i.type::text AS type,
           i.document_date::text AS document_date,
           i.document_name,
           i.audit_status::text AS audit_status,
           f.size_bytes,
           (SELECT count(DISTINCT x.address) FROM report.inquiry_sample x WHERE x.inquiry_id = i.id AND x.delete_date IS NULL) AS addresses,
           (SELECT count(*) FROM report.inquiry_sample x WHERE x.inquiry_id = i.id AND x.delete_date IS NULL) AS samples
      FROM report.inquiry i
      LEFT JOIN application.file_resources f ON f.key = 'inquiry-report/' || i.document_file
     WHERE i.delete_date IS NULL
       AND i.id IS DISTINCT FROM ${exceptInquiryId}
       AND EXISTS (SELECT 1 FROM report.inquiry_sample s
                    WHERE s.inquiry_id = i.id AND s.building_id = ${buildingId} AND s.delete_date IS NULL)
     ORDER BY i.document_date DESC NULLS LAST, i.id DESC
     LIMIT 25
  `)) as unknown as Row[];
  return markSameFile(rows, documentSizes);
}

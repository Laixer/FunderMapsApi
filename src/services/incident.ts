import { sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { incident } from "../db/schema/report.ts";
import { getBuildingByGeocoderId, getOldBuildingId } from "./geocoder.ts";
import { updateFileStatus } from "./storage.ts";
import { sendMail } from "./mail.ts";
import { env } from "../config.ts";

export interface CreateIncidentInput {
  clientId: number;
  building: string;
  foundationType?: string;
  chainedBuilding?: boolean;
  owner?: boolean;
  foundationRecovery?: boolean;
  neightborRecovery?: boolean;
  foundationDamageCause?: string;
  fileResourceKey?: string;
  documentFile?: string[];
  note?: string;
  contact: string;
  contactName?: string;
  contactPhoneNumber?: string;
  environmentDamageCharacteristics?: string[];
  foundationDamageCharacteristics?: string[];
  metadata?: Record<string, unknown>;
}

export async function createIncident(input: CreateIncidentInput) {
  // Validate building exists
  const building = await getBuildingByGeocoderId(input.building);

  // Get legacy building ID
  const legacyId = await getOldBuildingId(building.external_id);

  // Generate incident ID via database function
  const idResult = await db.execute(
    sql`SELECT report.fir_generate_id(${input.clientId}) as id`,
  );
  const incidentId = (idResult[0] as { id: string }).id;

  // Normalize empty phone number to null
  const phoneNumber =
    input.contactPhoneNumber?.trim() || null;

  const [created] = await db
    .insert(incident)
    .values({
      id: incidentId,
      foundationType: input.foundationType,
      chainedBuilding: input.chainedBuilding ?? false,
      owner: input.owner ?? false,
      foundationRecovery: input.foundationRecovery ?? false,
      neightborRecovery: input.neightborRecovery ?? false,
      foundationDamageCause: input.foundationDamageCause,
      fileResourceKey: input.fileResourceKey,
      documentFile: input.documentFile,
      note: input.note,
      contact: input.contact,
      contactName: input.contactName,
      contactPhoneNumber: phoneNumber,
      environmentDamageCharacteristics:
        input.environmentDamageCharacteristics,
      foundationDamageCharacteristics:
        input.foundationDamageCharacteristics,
      building: legacyId ?? building.external_id,
      metadata: input.metadata,
    })
    .returning();

  // Update file status if files were provided
  if (input.fileResourceKey) {
    await updateFileStatus(input.fileResourceKey, "active");
  }

  // Send email notification
  const receivers = env.EMAIL_RECEIVERS?.split(",").map((e) => e.trim()) ?? [];
  if (receivers.length > 0) {
    await sendMail({
      from: `FunderMaps <noreply@${env.MAILGUN_DOMAIN}>`,
      to: receivers,
      subject: `New incident report: ${incidentId}`,
      template: "incident-customer",
      variables: {
        id: incidentId,
        contact: input.contact,
        contactName: input.contactName ?? "",
        foundationType: input.foundationType ?? "unknown",
        chainedBuilding: input.chainedBuilding ? "Yes" : "No",
        owner: input.owner ? "Yes" : "No",
      },
    });
  }

  return created;
}

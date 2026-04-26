// No-op stubs for the inquiry status-transition emails the C# WebApi sends
// via Mailgun. Wave 3 ships without sending — single place to wire later.
// Mirrors C# templates `report-reviewer`, `report-declined`, `report-approved`.

export interface InquiryEmailContext {
  inquiryId: number;
  documentName: string;
  creatorEmail: string;
  creatorName: string;
  reviewerEmail: string;
  reviewerName: string;
  organizationName: string;
}

export async function sendReviewRequestedEmail(
  _ctx: InquiryEmailContext,
): Promise<void> {
  // intentionally no-op — wire when product wants email back
}

export async function sendApprovedEmail(
  _ctx: InquiryEmailContext,
): Promise<void> {
  // intentionally no-op
}

export async function sendRejectedEmail(
  _ctx: InquiryEmailContext & { motivation: string },
): Promise<void> {
  // intentionally no-op
}

/**
 * Transactional email. No provider is integrated yet, so delivery is not
 * configured and every caller must handle that explicitly (never log the
 * message instead: a reset link in a log is a credential leak).
 */
export function emailDeliveryConfigured(): boolean {
  return false;
}

export class EmailNotConfiguredError extends Error {
  readonly statusCode = 503;
  readonly code = "EMAIL_NOT_CONFIGURED";
  constructor() {
    super("No email provider is configured, so password-reset links cannot be delivered. See docs/ADMIN_CONTROL_CENTER.md.");
  }
}

export async function sendPasswordResetEmail(_to: string, _resetUrl: string): Promise<void> {
  throw new EmailNotConfiguredError();
}

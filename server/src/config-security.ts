export function validateProductionSecurityConfig(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== "production") return;

  if (env.QA_VERIFICATION_BYPASS_ENABLED === "true" || env.QA_ALLOW_PRODUCTION_BYPASS === "true") {
    throw new Error("Production cannot enable QA verification bypass");
  }

  if (env.DB_SSL_REJECT_UNAUTHORIZED !== "true") {
    throw new Error("Production requires DB_SSL_REJECT_UNAUTHORIZED=true");
  }
}

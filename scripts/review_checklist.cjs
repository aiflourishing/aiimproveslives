// Compatibility entry point for existing tooling. The trusted checker is shared with the webhook.
module.exports.run = async args => (await import('../supabase/functions/_shared/review-checklist.mjs')).run(args);

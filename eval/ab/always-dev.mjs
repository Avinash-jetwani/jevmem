// The always-on labels for the first outcome A/B's three projects (eval/ab/tasks.mjs), the dev side of 0.7.1's
// always-on work: which of each project's live lines is a rule or convention that applies whatever a task is about
// (logging, errors, i18n, CSS, tests, commits, branch policy, generated files, PII, formats of money, dates and ids,
// helpers that every call must go through, standing prohibitions), as against a fact or decision about one part of the
// system (the database, the page size, a status list, a deploy target), which recall finds when a task touches it.
// Labelled by hand before any design was measured; scripts/ab.mjs reads it with --always-labels, and the marking
// question of design B is measured against it. eval/ab/tasks.mjs itself is unchanged.
export const ALWAYS = {
  parcelpost: ["pp_ids", "pp_log", "pp_v1", "pp_errors", "pp_money", "pp_generated", "pp_http", "pp_tests", "pp_staging_db", "pp_migrations", "pp_log_pii", "pp_dates", "pp_main", "pp_commits"],
  recipebox: ["rb_query", "rb_img_alt", "rb_i18n", "rb_tests", "rb_css", "rb_locales", "rb_components", "rb_bundle", "rb_no_moment", "rb_env", "rb_legacy", "rb_a11y_focus", "rb_no_prices"],
  logslice: ["ls_nodeps", "ls_stream", "ls_exit", "ls_commits", "ls_tests", "ls_fail", "ls_windows", "ls_output", "ls_publish", "ls_errors_text", "ls_color", "ls_perf", "ls_branch", "ls_docs"],
};

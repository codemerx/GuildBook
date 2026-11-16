# @app/brand

The product's name and every value derived from it: display name, package name, app id, data folder name, protocol
scheme, instruction marker and the rest (PLAN.md §3.16). Everything else imports them from here. `pnpm brand:check`
fails when any of them appears anywhere else in the repository, translation files included (A1.16); only this package
and `docs/` may hold them. Translated texts insert the name through `{{appName}}`.

- **Imports:** nothing.
- **Imported by:** every other package and the app.

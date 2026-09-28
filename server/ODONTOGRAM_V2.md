# Odontogram V2 compatibility

- Authoritative metadata: src/utils/dentalTeeth.js. The browser file
  ../dental-tooth-catalog.js is an exact generated copy, not a separately
  maintained catalog. After editing the source, copy it to that public file.
  The V2 tests require byte-identical content. build:web copies both public
  dental helpers and the HTML sources into public-web; do not edit that output.
- 32 permanent IDs are preserved; 20 PRIMARY IDs are added. MIXED is view-only.
  New FDI labels are two-digit strings; Universal uses 1-32 and A-T.
  Existing persisted display snapshots (including dotted FDI) remain readable
  and are never rewritten. New selections derive their labels from metadata.
- Universal primary mapping follows the ADA Universal Tooth Designation System:
  https://www.ada.org/-/media/project/ada-organization/ada/ada-org/files/publications/cdt/universal_tooth_designation_system_valueset_2.pdf
- New odontogram and plan-item surfaces must match anatomical metadata.
  Whole-tooth null remains supported for new entries.
- Correction exception: after locking the original DB row and verifying the
  existing patient/tooth/type invariants, the exact original surface is allowed.
  Any different non-null surface must pass current anatomical validation.
  A historical non-anatomical non-null surface cannot be replaced with null
  (including omitted/empty input). This conservatively prevents silent loss.
  No client legacy flag or claimed previous surface is trusted.
- Correction UI inserts the original non-anatomical surface only in that form,
  labels it historical and selects it. Leaving that option removes it. New
  forms and other teeth never inherit it. Cancelling saves nothing.
- Appointments/notes reject unknown canonical IDs, invalid numbering systems,
  duplicates and arrays over 52 with HTTP 400; supplied display codes are ignored.
  Legacy standalone tooth_number validation remains for selections without IDs.
- Migration 26, migration_odontogram_primary_teeth.sql, follows the existing
  25 migrations. It transactionally replaces only the recognized single-column
  treatment_plan_items tooth check, retaining NULL and all valid permanent IDs.
  Repeated execution is supported. Unexpected constraints or incompatible rows
  fail the migration; no clinical rows are converted or deleted.
- The migration has NOT been applied to a real database by this implementation.
  Validate execution/re-execution and rollback on a disposable PostgreSQL
  database before deployment. Then manually verify the clinical UI and legacy
  correction workflow with a clinician. No primary plan items should be used
  against a database until the new check has been installed.

// The doctor module (IMPLEMENTATION.md §2.3, PLAN.md §3.4): the Doctor view's checks per tool, and what it takes from
// the tools' own commands. Diagnostics export comes in Step 16.
export {
  type DoctorDeps,
  type DoctorFolder,
  DoctorQuery,
  type DoctorReport,
  DoctorService,
  type DoctorTool,
  type InvalidName,
} from './app/doctor.ts';
export { filterListedSkills, parseVersion, splitCommand, versionDrift } from './domain/tool-output.ts';

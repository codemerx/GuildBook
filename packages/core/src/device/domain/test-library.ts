// Test libraries: a local folder as a library, in test and development builds only (Step 1's thin slice). Real
// libraries come from git URLs in Step 4.
import type { InstanceRecord } from '@app/schemas';
import { AppError } from '../../shared/errors.ts';
import type { PathFlavour } from '../../shared/paths.ts';
import { err, ok, type Result } from '../../shared/result.ts';

export interface TestLibraryRequest {
  readonly name: string;
  readonly path: string;
}

export function checkTestLibrary(
  request: TestLibraryRequest,
  existing: readonly Pick<InstanceRecord, 'name' | 'libraryPath'>[],
  paths: PathFlavour,
): Result<TestLibraryRequest, AppError> {
  const name = request.name.trim();
  if (name.length === 0 || name.length > 100 || /\p{Cc}/u.test(name)) {
    return err(new AppError('testLibrary.nameInvalid', { name }));
  }
  if (existing.some((instance) => instance.name.toLowerCase() === name.toLowerCase())) {
    return err(new AppError('testLibrary.alreadyAdded', { name }));
  }
  if (!paths.isAbsolute(request.path)) return err(new AppError('testLibrary.pathInvalid', { path: request.path }));
  const path = paths.normalize(request.path);
  if (existing.some((instance) => paths.same(instance.libraryPath, path))) {
    return err(new AppError('testLibrary.alreadyAdded', { path }));
  }
  return ok({ name, path });
}

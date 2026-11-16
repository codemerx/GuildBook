// The commit's questions (PLAN.md §3.10 "Commit", §3.8 S8, §3.15): the author's name and email, asked once when the
// host gave none, and the checks that need an answer before the commit: a skill deleted from the library, secrets found
// in the files, large files and validation problems. What's refused (letter-case clashes, files over 50 MB) is said
// on the page instead.
import type { CommitChecksView } from '@app/ipc';
import { FileWarning, KeyRound, Trash2, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button.tsx';
import { DialogShell } from '../../ui/dialog.tsx';
import { Input } from '../../ui/input.tsx';
import { SecretList } from './push-dialogs.tsx';

export function IdentityDialog({
  open,
  library,
  onCancel,
  onSave,
}: {
  open: boolean;
  library: string;
  onCancel: () => void;
  onSave: (identity: { name: string; email: string }) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const valid = name.trim() !== '' && /^[^@\s]+@[^@\s]+$/.test(email.trim());
  return (
    <DialogShell
      open={open}
      onOpenChange={(next) => !next && onCancel()}
      title={t('sync.identity.title')}
      description={t('sync.identity.body', { library })}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('sync.cancel')}
          </Button>
          <Button type="button" disabled={!valid} onClick={() => onSave({ name: name.trim(), email: email.trim() })}>
            {t('sync.identity.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t('sync.identity.name')}
          <Input value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {t('sync.identity.email')}
          <Input type="email" value={email} autoComplete="email" onChange={(e) => setEmail(e.target.value)} />
        </label>
      </div>
    </DialogShell>
  );
}

/** Whether the checks need the user's answer before the commit. */
export function needsAnswer(checks: CommitChecksView): boolean {
  return (
    checks.deletions.length > 0 ||
    checks.secrets.length > 0 ||
    checks.largeFiles.length > 0 ||
    checks.problems.length > 0
  );
}

const MB = 1024 * 1024;

export function ChecksDialog({
  checks,
  library,
  onCancel,
  onConfirm,
}: {
  checks: CommitChecksView | null;
  library: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (!checks) return null;
  const deleting = checks.deletions.length > 0;
  return (
    <DialogShell
      open
      onOpenChange={(open) => !open && onCancel()}
      title={t(deleting ? 'sync.checks.deleteTitle' : 'sync.checks.title', {
        skill: checks.deletions[0] ?? '',
        count: checks.deletions.length,
      })}
      description={t('sync.checks.body')}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('sync.cancel')}
          </Button>
          <Button type="button" onClick={onConfirm}>
            {t(deleting ? 'sync.checks.deleteAnyway' : 'sync.checks.commitAnyway')}
          </Button>
        </>
      }
    >
      {deleting && (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="flex items-center gap-2 font-semibold">
            <Trash2 aria-hidden="true" className="size-4 text-danger" />
            {t('sync.checks.deletions')}
          </h3>
          {checks.deletions.map((skill) => (
            <p key={skill}>{t('sync.checks.deletion', { skill, library })}</p>
          ))}
        </section>
      )}
      {checks.secrets.length > 0 && (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="flex items-center gap-2 font-semibold">
            <KeyRound aria-hidden="true" className="size-4 text-danger" />
            {t('sync.secrets.commitTitle')}
          </h3>
          <p>{t('sync.secrets.commitBody')}</p>
          <SecretList findings={checks.secrets} />
        </section>
      )}
      {checks.largeFiles.length > 0 && (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="flex items-center gap-2 font-semibold">
            <FileWarning aria-hidden="true" className="size-4 text-warning" />
            {t('sync.checks.large')}
          </h3>
          {checks.largeFiles.map((file) => (
            <p key={file.path}>
              <span className="font-mono">{file.path}</span> {t('sync.checks.size', { mb: Math.round(file.size / MB) })}
            </p>
          ))}
        </section>
      )}
      {checks.problems.length > 0 && (
        <section className="flex flex-col gap-1 text-sm">
          <h3 className="flex items-center gap-2 font-semibold">
            <TriangleAlert aria-hidden="true" className="size-4 text-warning" />
            {t('sync.checks.problems')}
          </h3>
          <ul className="flex flex-col gap-1">
            {checks.problems.map((problem) => (
              <li key={`${problem.path}:${problem.code}`}>
                {t('sync.checks.problem', { skill: problem.skill ?? '', path: problem.path })}
              </li>
            ))}
          </ul>
        </section>
      )}
    </DialogShell>
  );
}

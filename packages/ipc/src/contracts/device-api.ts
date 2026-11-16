// The device API: what the renderer asks of main (IMPLEMENTATION.md §2.1, §2.8).
import {
  GitIdentitySchema,
  InstanceIdSchema,
  NotificationSettingsSchema,
  ProtectedFolderSchema,
  SetupFolderChoiceSchema,
  SetupIdSchema,
  ThemeSchema,
} from '@app/schemas';
import { z } from 'zod';
import { api, command, query } from '../contract.ts';
import { CustomToolInstructionsViewSchema, ToolCommandViewSchema, ToolSettingsViewSchema } from './link-views.ts';
import { PickedFileViewSchema } from './editor-views.ts';
import { DeviceCodeProgressSchema, DownloadProgressSchema, SignInInputSchema } from './setup-api.ts';
import { InviteViewSchema } from './setup-views.ts';
import {
  AppInfoSchema,
  DiagnosticsViewSchema,
  DeviceSettingsViewSchema,
  InstanceViewSchema,
  SetupViewSchema,
  UpdateViewSchema,
  UrlCheckViewSchema,
} from './views.ts';

const Url = z.string().max(2048);
const SetupRef = z.object({ setupId: SetupIdSchema });

const Empty = z.object({});

/**
 * The window's two forms (PLAN.md §3.19): the full app, or the small status view that stands in for the tray icon on a
 * desktop without a tray.
 */
export const WindowModeSchema = z.object({ mode: z.enum(['full', 'status']) });
export type WindowMode = z.infer<typeof WindowModeSchema>;

export const deviceApi = api({
  queries: {
    appInfo: query(Empty, AppInfoSchema),
    instances: query(Empty, z.array(InstanceViewSchema)),
    settings: query(Empty, DeviceSettingsViewSchema),
    /** The first wizard page's check, as the user types (PLAN.md §3.15, A4.4, A4.12). */
    checkUrl: query(z.object({ url: Url }), UrlCheckViewSchema),
    /** Setups whose instance is still pending (IMPLEMENTATION.md §2.1). */
    setups: query(Empty, z.array(SetupViewSchema)),
    /** Custom tools and changed tool folders, kept once per device (PLAN.md §3.4). */
    toolSettings: query(Empty, ToolSettingsViewSchema),
    /** The last invite link the OS handed over (PLAN.md §3.17 step 1), until the renderer took it. */
    invite: query(Empty, InviteViewSchema.nullable()),
    /** Whether the window is the full app or the small status view (Step 17). */
    windowMode: query(Empty, WindowModeSchema),
    /** App updates and the catalog refresh (PLAN.md §3.19, Step 18). */
    updates: query(Empty, UpdateViewSchema),
  },
  commands: {
    /** Test and development builds only: a local folder as a library (Step 1's thin slice). */
    addTestLibrary: command(
      z.object({ name: z.string().trim().min(1).max(100), path: z.string().min(1).max(4096) }),
      z.object({ id: InstanceIdSchema }),
    ),
    /** Shows the OS folder dialog through main; tests answer it (TESTING.md §6). */
    chooseFolder: command(
      z.object({
        purpose: z.enum([
          'test-library',
          'library',
          'tool-folder',
          'repo',
          'repo-root',
          'relocation',
          'locate',
          'import-folder',
          'import-skill',
        ]),
      }),
      z.object({
        path: z.string().nullable(),
        /**
         * macOS (Step 17): a repo folder inside Desktop, Documents or Downloads, whose notice the user hasn't seen. The
         * window explains the system's access prompt before the app reads the folder (A17.9).
         */
        accessNotice: ProtectedFolderSchema.optional(),
      }),
    ),
    /** The user read the notice about a protected folder (Step 17): it isn't shown again. */
    noticeFolderAccess: command(z.object({ folder: ProtectedFolderSchema }), Empty),
    /** The OS file dialog for a `.zip` or `.skill` file to import (PLAN.md §3.18 C); the worker reads it. */
    chooseImportFile: command(Empty, z.object({ path: z.string().nullable() })),
    /** Shows the OS file dialog through main, which reads the picked file (PLAN.md §3.7: files the user picks). */
    pickFile: command(z.object({ purpose: z.enum(['instructions', 'skill-file']) }), PickedFileViewSchema),
    /**
     * The signing key (Step 12, PLAN.md §3.10): the OS file dialog for the user's public key file; main reads its first
     * line only (PLAN.md §3.7 rule 5). Null for "Cancel".
     */
    pickSigningKey: command(Empty, z.object({ path: z.string(), publicKey: z.string().max(20_000) }).nullable()),
    /** Joining or creating a library starts here: a pending worker for the URL (PLAN.md §3.17). */
    startSetup: command(
      z.object({
        url: Url,
        intent: z.enum(['join', 'create']),
        /** The client id an invite link carried (PLAN.md §3.17 step 2). */
        clientId: z.string().max(200).nullable().optional(),
      }),
      z.object({ setupId: z.string() }),
    ),
    setupSignIn: command(SetupRef.extend(SignInInputSchema.shape), SetupViewSchema, {
      progress: DeviceCodeProgressSchema,
    }),
    setupIdentity: command(SetupRef.extend({ identity: GitIdentitySchema }), SetupViewSchema),
    setupCheckFolder: command(SetupRef.extend({ path: z.string().min(1).max(4096) }), SetupViewSchema),
    setupDownload: command(SetupRef, SetupViewSchema, { progress: DownloadProgressSchema }),
    setupCreate: command(SetupRef.extend({ prefix: z.string().max(100) }), SetupViewSchema),
    setupJoinInstead: command(SetupRef, SetupViewSchema),
    /** The local-prefix page (Step 8): check a prefix while the user types, then choose it. */
    setupCheckLocalPrefix: command(SetupRef.extend({ prefix: z.string().max(100) }), SetupViewSchema),
    setupChooseLocalPrefix: command(SetupRef.extend({ prefix: z.string().max(100) }), SetupViewSchema),
    /** The prefix check's [Move my folder] and [Keep it] for each of the user's folders (PLAN.md §3.17 step 5). */
    setupChooseFolders: command(
      SetupRef.extend({ choices: z.array(SetupFolderChoiceSchema).max(1000) }),
      SetupViewSchema,
    ),
    /** Before the download is complete, nothing is kept (IMPLEMENTATION.md §2.1, A4.11). */
    cancelSetup: command(SetupRef, Empty),
    /** The wizard's [Finish]: the summary's plan is applied if it still holds, and the instance is ready. */
    finishSetup: command(z.object({ instanceId: InstanceIdSchema, planHash: z.string().min(1).max(200) }), Empty),
    /** The renderer showed the invite link's page: main forgets it. */
    takeInvite: command(z.object({ seq: z.number().int() }), Empty),
    /** Settings → Launch at login (PLAN.md §3.19). */
    setLaunchAtLogin: command(z.object({ on: z.boolean() }), Empty),
    /** The status view's [Open]: the window becomes the full app again. */
    openFullWindow: command(Empty, Empty),
    /** The status view's [Quit], which stands in for the tray's Quit. */
    quitApp: command(Empty, Empty),
    /** Settings → Notifications: the types switched off, and Do not disturb (PLAN.md §3.19, Step 17). */
    setNotifications: command(NotificationSettingsSchema, Empty),
    /**
     * Settings → Extra certificates → [Add certificate…] (PLAN.md §3.19): a PEM file the user picks; every
     * certificate in it is trusted from then on. `added` is 0 when the user cancelled or all were there already.
     */
    addCertificate: command(Empty, z.object({ added: z.number().int().nonnegative() })),
    removeCertificate: command(z.object({ fingerprint: z.string().min(1).max(200) }), Empty),
    /** Settings → Updates → [Check now]: the app's update and the tool catalog, at once. */
    checkForUpdates: command(Empty, UpdateViewSchema),
    /** [Download] once a newer version is out: its release page opens in the browser (ADR 0031). */
    openUpdateDownload: command(Empty, Empty),
    /** [Later] on the banner: it goes until a newer version is out, or the app starts again. */
    dismissUpdate: command(Empty, Empty),
    /** Settings → Change URL, also offered for the same library under another URL (PLAN.md §3.1, A4.4). */
    changeUrl: command(z.object({ instanceId: InstanceIdSchema, url: Url }), Empty),
    /** Removes an instance as a device operation (IMPLEMENTATION.md §2.6, PLAN.md §3.8 S12). */
    removeInstance: command(z.object({ instanceId: InstanceIdSchema, deleteFolder: z.boolean() }), Empty),
    /**
     * Settings → Remove everything this app set up (PLAN.md §3.8 S12): every instance's links, blocks, entries and
     * copies, then the instances. Library folders stay.
     */
    removeEverything: command(Empty, z.object({ removed: z.number().int().nonnegative() })),
    setTheme: command(z.object({ theme: ThemeSchema }), Empty),
    /** The tools page's [Change folder…] and [Use the default] (PLAN.md §3.4 "Moved tool folders"). */
    setToolFolder: command(
      z.object({ toolId: z.string().min(1).max(200), path: z.string().min(1).max(4096).nullable() }),
      Empty,
    ),
    /** A custom tool: a name and the folder it reads skills from (PLAN.md §3.4 "Custom tools"). */
    addCustomTool: command(
      z.object({
        name: z.string().trim().min(1).max(100),
        skillDir: z.string().min(1).max(4096),
        /** Optionally an instructions file and its method (Step 7). */
        instructions: CustomToolInstructionsViewSchema.nullable().optional(),
        /** A copy target (Step 16): the folder gets copies instead of links (PLAN.md §3.4 copy mode). */
        copy: z.boolean().optional(),
      }),
      z.object({ id: z.string() }),
    ),
    /**
     * The Instructions page (PLAN.md §3.12): [Link], refused with `instructions.othersLinked` while another company's
     * are linked; [Link anyway]; [Unlink Acme's and link Globex's] (`switch`); [Unlink].
     */
    setInstructionsLinked: command(
      z.object({ instanceId: InstanceIdSchema, action: z.enum(['link', 'link-anyway', 'switch', 'unlink']) }),
      Empty,
    ),
    /** The Doctor's [Run] next to a tool's `list_command`; the skill names come back filtered to prefixes in use. */
    runToolCommand: command(
      z.object({ toolId: z.string().min(1).max(200), which: z.enum(['version', 'list']) }),
      ToolCommandViewSchema,
    ),
    /** Puts a text on the clipboard: Cursor's instructions to paste (PLAN.md §3.12). */
    copyText: command(z.object({ text: z.string().max(1_000_000) }), Empty),
    removeCustomTool: command(z.object({ id: z.string().min(1).max(200) }), Empty),
    /**
     * Export diagnostics (PLAN.md §3.13, Step 16): main gathers the logs and the Doctor reports, redacted, for the user
     * to review. Nothing leaves the device.
     */
    prepareDiagnostics: command(Empty, DiagnosticsViewSchema),
    /** [Save…]: writes the reviewed text where the user chooses; `path` is null when they cancel. */
    saveDiagnostics: command(z.object({ id: z.string().min(1).max(100) }), z.object({ path: z.string().nullable() })),
    /** Opens a link in the browser, only for http(s) URLs (IMPLEMENTATION.md §2.12). */
    openExternal: command(z.object({ url: z.string().min(1).max(2048) }), Empty),
    /** Errors the renderer caught, for main's log (IMPLEMENTATION.md §2.12). */
    reportRendererError: command(
      z.object({ message: z.string().max(10_000), stack: z.string().max(50_000).optional() }),
      Empty,
    ),
  },
  events: {
    instancesChanged: z.object({ instances: z.array(InstanceViewSchema) }),
    settingsChanged: DeviceSettingsViewSchema,
    /** The tray's "Open Acme": show this library (ADR 0004). */
    showInstance: z.object({ instanceId: InstanceIdSchema }),
    setupsChanged: z.object({ setups: z.array(SetupViewSchema) }),
    toolSettingsChanged: ToolSettingsViewSchema,
    /** An invite link arrived (PLAN.md §3.17 step 1): the window shows "Join Acme". */
    inviteOpened: InviteViewSchema,
    windowModeChanged: WindowModeSchema,
    updatesChanged: UpdateViewSchema,
  },
});

export type DeviceApi = typeof deviceApi;

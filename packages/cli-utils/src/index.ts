import * as util from 'util';
import * as path from 'path';

import { isCI } from 'ci-info';
import * as chalk from 'chalk';
import * as minimist from 'minimist';

import * as inquirerType from 'inquirer';

import { IHookEngine, IonicEnvironment, RootPlugin } from './definitions';
import { load } from './lib/modules';

import { BACKEND_LEGACY } from './lib/backends';
import { CONFIG_DIRECTORY, CONFIG_FILE, Config, gatherFlags } from './lib/config';
import { DAEMON_JSON_FILE, Daemon } from './lib/daemon';
import { Client } from './lib/http';
import { CLIEventEmitter } from './lib/events';
import { HookEngine } from './lib/hooks';
import { PROJECT_FILE, PROJECT_FILE_LEGACY, Project } from './lib/project';
import { Logger } from './lib/utils/logger';
import { findBaseDirectory } from './lib/utils/fs';
import { InteractiveTaskChain, TaskChain } from './lib/utils/task';
import { Telemetry } from './lib/telemetry';
import { CloudSession, ProSession } from './lib/session';
import { Shell } from './lib/shell';
import { createPromptModule } from './lib/prompts';

export * from './definitions';
export * from './guards';

export * from './lib/app';
export * from './lib/backends';
export * from './lib/command';
export * from './lib/command/command';
export * from './lib/command/namespace';
export * from './lib/command/utils';
export * from './lib/config';
export * from './lib/daemon';
export * from './lib/deploy';
export * from './lib/errors';
export * from './lib/events';
export * from './lib/help';
export * from './lib/hooks';
export * from './lib/http';
export * from './lib/login';
export * from './lib/package';
export * from './lib/plugins';
export * from './lib/project';
export * from './lib/prompts';
export * from './lib/security';
export * from './lib/session';
export * from './lib/shell';
export * from './lib/telemetry';
export * from './lib/utils/archive';
export * from './lib/utils/array';
export * from './lib/utils/environmentInfo';
export * from './lib/utils/format';
export * from './lib/utils/fs';
export * from './lib/utils/logger';
export * from './lib/utils/network';
export * from './lib/utils/npm';
export * from './lib/utils/promise';
export * from './lib/utils/shell';
export * from './lib/utils/string';
export * from './lib/utils/task';
export * from './lib/validators';

export const name = '__NAME__';
export const version = '__VERSION__';

export function registerHooks(hooks: IHookEngine) {
  hooks.register(name, 'command:info', async () => {
    return [
      { type: 'cli-packages', name, version, path: path.dirname(__filename) },
    ];
  });
}

export async function generateIonicEnvironment(plugin: RootPlugin, pargv: string[], env: { [key: string]: string }): Promise<IonicEnvironment> {
  const argv = minimist(pargv, { boolean: true, string: '_' });
  const config = new Config(env['IONIC_CONFIG_DIRECTORY'] || CONFIG_DIRECTORY, CONFIG_FILE);
  const configData = await config.load();
  const flags = gatherFlags(argv);

  let stream: NodeJS.WritableStream;
  let tasks: TaskChain;
  let bottomBar: inquirerType.ui.BottomBar | undefined;
  let log: Logger;

  if (isCI) {
    flags.interactive = false;
  }

  if (flags.interactive) {
    const inquirer = load('inquirer');
    bottomBar = new inquirer.ui.BottomBar();
    open();

    stream = bottomBar.log;
    log = new Logger({ stream });
    tasks = new InteractiveTaskChain({ log, bottomBar });
  } else {
    stream = process.stdout;
    log = new Logger({ stream });
    tasks = new TaskChain({ log });
  }

  if (argv['log-level']) {
    log.level = argv['log-level'];
  }

  if (argv['log-timestamps']) {
    log.prefix = () => `${chalk.dim('[' + new Date().toISOString() + ']')}`;
  }

  log.debug(`CLI flags: ${util.inspect(flags, { breakLength: Infinity, colors: chalk.enabled })}`);

  if (typeof argv['yarn'] === 'boolean') {
    log.warn(`${chalk.green('--yarn')} / ${chalk.green('--no-yarn')} switch is deprecated. Use ${chalk.green('ionic config set -g yarn ' + String(argv['yarn']))}.`);
    configData.yarn = argv['yarn'];
  }

  const projectDir = await findBaseDirectory(process.cwd(), PROJECT_FILE);

  if (!projectDir) {
    const foundDir = await findBaseDirectory(process.cwd(), PROJECT_FILE_LEGACY);

    if (foundDir) {
      log.warn(`${chalk.bold(PROJECT_FILE_LEGACY)} file found in ${chalk.bold(foundDir)}--please rename it to ${chalk.bold(PROJECT_FILE)}, or your project directory will not be detected!`);
    }
  }

  function open() {
    if (flags.interactive) {
      if (!bottomBar) {
        const inquirer = load('inquirer');
        bottomBar = new inquirer.ui.BottomBar();
      }

      try { // TODO
        const bottomBarHack = <any>bottomBar;
        bottomBarHack.rl.output.mute();
      } catch (e) {
        console.error('EXCEPTION DURING BOTTOMBAR OUTPUT MUTE', e);
      }
    }
  }

  function close() {
    tasks.cleanup();

    // instantiating inquirer.ui.BottomBar hangs, so when close() is called,
    // we close BottomBar streams and replace the log stream with stdout.
    // This means inquirer shouldn't be used after command execution finishes
    // (which could happen during long-running processes like serve).
    if (bottomBar) {
      bottomBar.close();
      bottomBar = undefined;
      log.stream = process.stdout;
    }
  }

  env['IONIC_PROJECT_DIR'] = projectDir || '';
  env['IONIC_PROJECT_FILE'] = PROJECT_FILE;

  const project = new Project(env['IONIC_PROJECT_DIR'], PROJECT_FILE);
  const client = new Client(configData.urls.api);
  const session = configData.backend === BACKEND_LEGACY ? new CloudSession(config, project, client) : new ProSession(config, project, client);
  const hooks = new HookEngine();
  const telemetry = new Telemetry(config, plugin.version);
  const shell = new Shell(tasks, log);

  registerHooks(hooks);

  return {
    client,
    close,
    config,
    daemon: new Daemon(CONFIG_DIRECTORY, DAEMON_JSON_FILE),
    events: new CLIEventEmitter(),
    flags,
    hooks,
    load,
    log,
    namespace: plugin.namespace,
    open,
    plugins: {
      ionic: plugin,
    },
    prompt: await createPromptModule({ confirm: flags.confirm, interactive: flags.interactive, log, config }),
    project,
    session,
    shell,
    tasks,
    telemetry,
  };
}

import { Injectable } from '@angular/core';
// If you import a module but never use any of the imported values other than as TypeScript types,
// the resulting javascript file will look as if you never imported the module at all.
import { ipcRenderer, Renderer, shell, webFrame } from 'electron';
import { IS_ELECTRON } from '../../app.constants';
import { getElectronRemoteModule } from '../../util/get-electron-remote-module';
import { getElectron } from '../../util/get-electron';
import * as remote from '@electron/remote';

// TODO make available for both
export const getSendChannel = (channel: string): string =>
  `%better-ipc-send-channel-${channel}`;
const getUniqueId = (): string => `${Date.now()}-${Math.random()}`;

// const getRendererSendChannel = (windowId, channel) => `%better-ipc-send-channel-${windowId}-${channel}`;
const getResponseChannels = (
  channel: string,
): {
  sendChannel: string;
  dataChannel: string;
  errorChannel: string;
} => {
  const id = getUniqueId();
  return {
    sendChannel: getSendChannel(channel),
    dataChannel: `%better-ipc-response-data-channel-${channel}-${id}`,
    errorChannel: `%better-ipc-response-error-channel-${channel}-${id}`,
  };
};

@Injectable({ providedIn: 'root' })
export class ElectronService {
  ipcRenderer?: typeof ipcRenderer;
  webFrame?: typeof webFrame;
  remote!: typeof remote;
  shell?: typeof shell;

  // fs: typeof fs;

  constructor() {
    // Conditional imports
    if (IS_ELECTRON) {
      const electron = getElectron() as typeof Renderer;
      this.ipcRenderer = electron.ipcRenderer;
      this.webFrame = electron.webFrame;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      this.remote = getElectronRemoteModule()!;
      // NOTE: works for non-sandboxed electron only
      this.shell = (electron as any).shell;

      // log to file for production
      // if (environment.production || environment.stage) {
      // const log = (this.remote as typeof remote).require('electron-log');
      // log.transports.maxSize = 1024 * 1024 * 20;
      // console.error = log.error;
      // console.log = log.log;
      // console.warn = log.warn;
      // }
    }

    // NOTE: useful in case we want to disable the node integration
    // NOTE: global-error-handler.class.ts also needs to be adjusted
    // this.ipcRenderer = {
    //   on: (channel: string, listener: (event: IpcRendererEvent, ...args: any[]) => void) => {
    //   },
    //   send: () => {
    //   }
    // };
    // this.webFrame = {
    //   setZoomFactor(factor: number): void {
    //   },
    //   getZoomFactor: () => 1
    // };
  }

  get isElectron(): boolean {
    return !!(window && window.process && window.process.type);
  }

  public get isElectronApp(): boolean {
    return !!window.navigator.userAgent.match(/Electron/);
  }

  // TODO move to a better place
  public get isMacOS(): boolean {
    return this.isElectronApp && this.process && this.process.platform === 'darwin';
  }

  public get process(): any {
    return this.remote ? this.remote.process : null;
  }

  public callMain(channel: string, data: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const { sendChannel, dataChannel, errorChannel } = getResponseChannels(channel);

      const cleanup = (): void => {
        (this.ipcRenderer as typeof ipcRenderer).off(dataChannel, onData);
        (this.ipcRenderer as typeof ipcRenderer).off(errorChannel, onError);
      };

      const onData = (event: unknown, result: unknown): void => {
        cleanup();
        resolve(result);
      };

      const onError = (event: unknown, error: unknown): void => {
        cleanup();
        // reject(deserializeError(error));
        reject(error);
      };

      (this.ipcRenderer as typeof ipcRenderer).once(dataChannel, onData);
      (this.ipcRenderer as typeof ipcRenderer).once(errorChannel, onError);

      const completeData = {
        dataChannel,
        errorChannel,
        userData: data,
      };

      (this.ipcRenderer as typeof ipcRenderer).send(sendChannel, completeData);
    });
  }
}

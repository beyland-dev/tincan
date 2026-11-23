import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNELS, type TincanBridge } from "../shared/bridge.ts";

function listen<T>(channel: string, handler: (value: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, value: T) => handler(value);
  ipcRenderer.on(channel, listener);
  return () => void ipcRenderer.off(channel, listener);
}

const bridge: TincanBridge = {
  run: (name, input) => ipcRenderer.invoke(CHANNELS.run, name, input),
  state: () => ipcRenderer.invoke(CHANNELS.state),
  onEvent: (handler) => listen(CHANNELS.event, handler),
  onState: (handler) => listen(CHANNELS.stateChanged, handler),
  onOpenThread: (handler) => listen(CHANNELS.openThread, handler),
  setUnread: (count) => ipcRenderer.send(CHANNELS.unread, count),
  getTheme: () => ipcRenderer.invoke(CHANNELS.getTheme),
  setTheme: (theme) => ipcRenderer.invoke(CHANNELS.setTheme, theme),
  previewTheme: (theme) => ipcRenderer.send(CHANNELS.previewTheme, theme),
  linkPreview: (url) => ipcRenderer.invoke(CHANNELS.linkPreview, url),
  getLinkPreviews: () => ipcRenderer.invoke(CHANNELS.getLinkPreviews),
  setLinkPreviews: (on) => ipcRenderer.invoke(CHANNELS.setLinkPreviews, on),
  getSpellcheck: () => ipcRenderer.invoke(CHANNELS.getSpellcheck),
  setSpellcheck: (on) => ipcRenderer.invoke(CHANNELS.setSpellcheck, on),
  copyText: (text) => ipcRenderer.invoke(CHANNELS.copyText, text),
  platform: process.platform,
};

contextBridge.exposeInMainWorld("tincan", bridge);

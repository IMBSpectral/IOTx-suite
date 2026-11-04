import { EventEmitter } from "node:events";

/**
 * In-process pub/sub for Server-Sent Events (one Workspace process). Topics:
 * "ws:<workspaceId>" for chat events and "user:<userId>" for notifications.
 */
const g = globalThis as unknown as { __iotxBus?: EventEmitter };
export const bus = g.__iotxBus ?? (g.__iotxBus = new EventEmitter());
bus.setMaxListeners(0);

export type BusEvent = { type: string; [k: string]: unknown };
export const publish = (topic: string, ev: BusEvent) => bus.emit(topic, ev);

// EventSource polyfill — MUST be imported before any Ark SDK imports
import { EventSource } from 'eventsource';
Object.assign(globalThis, { EventSource });

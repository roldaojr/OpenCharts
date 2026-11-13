import { rti } from "./generated/rti.js";
import { DECODERS, type MessageCodec } from "./templates.ts";

/**
 * Wire format: every WebSocket binary frame is exactly one protobuf message,
 * with no length prefix. Every message has `template_id` at field 154467, so a
 * frame is first read as `MessageType` (unknown fields are skipped) to learn
 * which concrete type to decode it as.
 */

export interface DecodedFrame {
  templateId: number;
  /** The decoded message, or null when the template is not one the adapter knows. */
  message: unknown;
}

export function encodeMessage<M extends { templateId: number }>(codec: MessageCodec<M>, body: M): Uint8Array {
  return codec.encode(body).finish();
}

export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // Tag check rather than instanceof: the buffer may come from another realm (iframe, test DOM).
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
    return new Uint8Array(data as ArrayBuffer);
  }
  return null;
}

export function decodeFrame(bytes: Uint8Array): DecodedFrame {
  const { templateId } = rti.MessageType.decode(bytes);
  const codec = DECODERS[templateId];
  return { templateId, message: codec ? codec.decode(bytes) : null };
}

/** Fields every request/response shares; used for correlation and status. */
export interface ReplyFields {
  templateId: number;
  userMsg?: string[] | null;
  rpCode?: string[] | null;
  rqHandlerRpCode?: string[] | null;
}

/** Thrown when Rithmic answers a request with a non-zero `rp_code`. */
export class RithmicError extends Error {
  readonly code: string;
  readonly templateId: number;

  constructor(code: string, text: string | undefined, templateId: number) {
    super(text ? text : `Rithmic error ${code}`);
    this.name = "RithmicError";
    this.code = code;
    this.templateId = templateId;
  }
}

/** Rithmic answers "nothing found" with rp_code 7 ("no data"); callers treat it as empty. */
export function isNoData(err: unknown): boolean {
  return err instanceof RithmicError && err.code === "7";
}

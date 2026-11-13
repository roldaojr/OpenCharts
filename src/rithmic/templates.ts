import { rti } from "./generated/rti.js";

/**
 * R|Protocol template IDs: the `template_id` (field 154467) every message
 * carries, which is how a frame is routed before it is decoded.
 *
 * The .proto files do not contain these numbers. IDs marked `// ✔` are used by
 * the official samples in ./samples and are confirmed; the rest come from the
 * R|Protocol API Reference Guide. If Rithmic renumbers a message, this file is
 * the only place to change.
 */
export const T = {
  // shared, any plant
  RequestLogin: 10, // ✔
  ResponseLogin: 11, // ✔
  RequestLogout: 12, // ✔
  ResponseLogout: 13, // ✔
  RequestReferenceData: 14,
  ResponseReferenceData: 15,
  RequestRithmicSystemInfo: 16, // ✔
  ResponseRithmicSystemInfo: 17, // ✔
  RequestHeartbeat: 18, // ✔
  ResponseHeartbeat: 19, // ✔
  Reject: 75,
  ForcedLogout: 77,

  // ticker plant
  RequestMarketDataUpdate: 100, // ✔
  ResponseMarketDataUpdate: 101, // ✔
  RequestSearchSymbols: 109,
  ResponseSearchSymbols: 110,
  RequestFrontMonthContract: 113,
  ResponseFrontMonthContract: 114,
  LastTrade: 150, // ✔
  BestBidOffer: 151, // ✔

  // history plant
  RequestTimeBarReplay: 202,
  ResponseTimeBarReplay: 203,
  RequestResumeBars: 210,
  ResponseResumeBars: 211,

  // order plant
  RequestLoginInfo: 300, // ✔
  ResponseLoginInfo: 301, // ✔
  RequestAccountList: 302, // ✔
  ResponseAccountList: 303, // ✔
  RequestSubscribeForOrderUpdates: 308, // ✔
  ResponseSubscribeForOrderUpdates: 309, // ✔
  RequestTradeRoutes: 310, // ✔
  ResponseTradeRoutes: 311, // ✔
  RequestNewOrder: 312, // ✔
  ResponseNewOrder: 313, // ✔
  RequestModifyOrder: 314,
  ResponseModifyOrder: 315,
  RequestCancelOrder: 316,
  ResponseCancelOrder: 317,
  RequestShowOrders: 320,
  ResponseShowOrders: 321,
  RequestBracketOrder: 330,
  ResponseBracketOrder: 331,
  RequestUpdateTargetBracketLevel: 332,
  ResponseUpdateTargetBracketLevel: 333,
  RequestUpdateStopBracketLevel: 334,
  ResponseUpdateStopBracketLevel: 335,
  RequestSubscribeToBracketUpdates: 336,
  ResponseSubscribeToBracketUpdates: 337,
  RequestShowBrackets: 338,
  ResponseShowBrackets: 339,
  RequestCancelAllOrders: 346,
  ResponseCancelAllOrders: 347,
  RithmicOrderNotification: 351, // ✔
  ExchangeOrderNotification: 352, // ✔
  BracketUpdates: 353,
  RequestExitPosition: 3504,
  ResponseExitPosition: 3505,

  // pnl plant
  RequestPnLPositionUpdates: 400,
  ResponsePnLPositionUpdates: 401,
  RequestPnLPositionSnapshot: 402,
  ResponsePnLPositionSnapshot: 403,
  InstrumentPnLPositionUpdate: 450,
  AccountPnLPositionUpdate: 451,
} as const;

export type TemplateName = keyof typeof T;

/** Anything with a static protobufjs `decode`/`encode`. */
export interface MessageCodec<M> {
  encode(message: M): { finish(): Uint8Array };
  decode(data: Uint8Array): M;
}

/** Decoder for every inbound template the adapter understands. */
export const DECODERS: Readonly<Record<number, MessageCodec<unknown>>> = {
  [T.ResponseLogin]: rti.ResponseLogin,
  [T.ResponseLogout]: rti.ResponseLogout,
  [T.ResponseReferenceData]: rti.ResponseReferenceData,
  [T.ResponseRithmicSystemInfo]: rti.ResponseRithmicSystemInfo,
  [T.ResponseHeartbeat]: rti.ResponseHeartbeat,
  [T.Reject]: rti.Reject,
  [T.ForcedLogout]: rti.ForcedLogout,
  [T.ResponseMarketDataUpdate]: rti.ResponseMarketDataUpdate,
  [T.ResponseSearchSymbols]: rti.ResponseSearchSymbols,
  [T.ResponseFrontMonthContract]: rti.ResponseFrontMonthContract,
  [T.LastTrade]: rti.LastTrade,
  [T.BestBidOffer]: rti.BestBidOffer,
  [T.ResponseTimeBarReplay]: rti.ResponseTimeBarReplay,
  [T.ResponseResumeBars]: rti.ResponseResumeBars,
  [T.ResponseLoginInfo]: rti.ResponseLoginInfo,
  [T.ResponseAccountList]: rti.ResponseAccountList,
  [T.ResponseSubscribeForOrderUpdates]: rti.ResponseSubscribeForOrderUpdates,
  [T.ResponseTradeRoutes]: rti.ResponseTradeRoutes,
  [T.ResponseNewOrder]: rti.ResponseNewOrder,
  [T.ResponseModifyOrder]: rti.ResponseModifyOrder,
  [T.ResponseCancelOrder]: rti.ResponseCancelOrder,
  [T.ResponseShowOrders]: rti.ResponseShowOrders,
  [T.ResponseBracketOrder]: rti.ResponseBracketOrder,
  [T.ResponseUpdateTargetBracketLevel]: rti.ResponseUpdateTargetBracketLevel,
  [T.ResponseUpdateStopBracketLevel]: rti.ResponseUpdateStopBracketLevel,
  [T.ResponseSubscribeToBracketUpdates]: rti.ResponseSubscribeToBracketUpdates,
  [T.ResponseShowBrackets]: rti.ResponseShowBrackets,
  [T.ResponseCancelAllOrders]: rti.ResponseCancelAllOrders,
  [T.RithmicOrderNotification]: rti.RithmicOrderNotification,
  [T.ExchangeOrderNotification]: rti.ExchangeOrderNotification,
  [T.BracketUpdates]: rti.BracketUpdates,
  [T.ResponseExitPosition]: rti.ResponseExitPosition,
  [T.ResponsePnLPositionUpdates]: rti.ResponsePnLPositionUpdates,
  [T.ResponsePnLPositionSnapshot]: rti.ResponsePnLPositionSnapshot,
  [T.InstrumentPnLPositionUpdate]: rti.InstrumentPnLPositionUpdate,
  [T.AccountPnLPositionUpdate]: rti.AccountPnLPositionUpdate,
};

/** `RequestLogin.SysInfraType`: which plant a socket logs in to. */
export const InfraType = rti.RequestLogin.SysInfraType;
export type InfraType = rti.RequestLogin.SysInfraType;

export const PLANT_NAMES: Readonly<Record<number, string>> = {
  [InfraType.TICKER_PLANT]: "ticker",
  [InfraType.ORDER_PLANT]: "order",
  [InfraType.HISTORY_PLANT]: "history",
  [InfraType.PNL_PLANT]: "pnl",
  [InfraType.REPOSITORY_PLANT]: "repository",
};

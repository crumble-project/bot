import { Layer } from "effect";
import { DesktopControl } from "../bot-desktop/desktop-control";
import { productLayer } from "./product-layer";

/** The account's repositories and the services that need nothing else: the base every account runtime starts from. */
export const coreLayer = (dataDir: string) =>
  DesktopControl.layer.pipe(Layer.provideMerge(productLayer(dataDir)));

export type CoreServices = Layer.Success<ReturnType<typeof coreLayer>>;

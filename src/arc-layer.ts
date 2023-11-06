import {
  CompositeLayer,
  CompositeLayerProps,
  DefaultProps,
  GetPickingInfoParams,
  Layer,
  LayersList,
  Unit,
} from "@deck.gl/core/typed";
import { ArcLayer } from "@deck.gl/layers/typed";
import type { ArcLayerProps } from "@deck.gl/layers/typed";
import * as arrow from "apache-arrow";
import {
  assignAccessor,
  getPointChild,
  validateColorVector,
  validatePointType,
  validateVectorAccessors,
} from "./utils.js";
import {
  ColorAccessor,
  FloatAccessor,
  GeoArrowPickingInfo,
  PointVector,
} from "./types.js";

const DEFAULT_COLOR: [number, number, number, number] = [0, 0, 0, 255];

/** All properties supported by GeoArrowArcLayer */
export type GeoArrowArcLayerProps = _GeoArrowArcLayerProps &
  CompositeLayerProps;

/** Properties added by GeoArrowArcLayer */
type _GeoArrowArcLayerProps = {
  data?: arrow.Table;

  /**
   * If `true`, create the arc along the shortest path on the earth surface.
   * @default false
   */
  greatCircle?: boolean;

  /**
   * The number of segments used to draw each arc.
   * @default 50
   */
  numSegments?: number;

  /**
   * The units of the line width, one of `'meters'`, `'common'`, and `'pixels'`
   * @default 'pixels'
   */
  widthUnits?: Unit;

  /**
   * The scaling multiplier for the width of each line.
   * @default 1
   */
  widthScale?: number;

  /**
   * The minimum line width in pixels.
   * @default 0
   */
  widthMinPixels?: number;

  /**
   * The maximum line width in pixels.
   * @default Number.MAX_SAFE_INTEGER
   */
  widthMaxPixels?: number;

  /**
   * Method called to retrieve the source position of each object.
   */
  getSourcePosition: PointVector;

  /**
   * Method called to retrieve the target position of each object.
   */
  getTargetPosition: PointVector;

  /**
   * The rgba color is in the format of `[r, g, b, [a]]`.
   * @default [0, 0, 0, 255]
   */
  getSourceColor?: ColorAccessor;

  /**
   * The rgba color is in the format of `[r, g, b, [a]]`.
   * @default [0, 0, 0, 255]
   */
  getTargetColor?: ColorAccessor;

  /**
   * The line width of each object, in units specified by `widthUnits`.
   * @default 1
   */
  getWidth?: FloatAccessor;

  /**
   * Multiplier of layer height. `0` will make the layer flat.
   * @default 1
   */
  getHeight?: FloatAccessor;

  /**
   * Use to tilt the arc to the side if you have multiple arcs with the same source and target positions.
   * @default 0
   */
  getTilt?: FloatAccessor;

  /**
   * If `true`, validate the arrays provided (e.g. chunk lengths)
   * @default true
   */
  _validate?: boolean;
};

const defaultProps: DefaultProps<GeoArrowArcLayerProps> = {
  _validate: true,

  getSourceColor: { type: "accessor", value: DEFAULT_COLOR },
  getTargetColor: { type: "accessor", value: DEFAULT_COLOR },
  getWidth: { type: "accessor", value: 1 },
  getHeight: { type: "accessor", value: 1 },
  getTilt: { type: "accessor", value: 0 },

  greatCircle: false,
  numSegments: { type: "number", value: 50, min: 1 },

  widthUnits: "pixels",
  widthScale: { type: "number", value: 1, min: 0 },
  widthMinPixels: { type: "number", value: 0, min: 0 },
  widthMaxPixels: { type: "number", value: Number.MAX_SAFE_INTEGER, min: 0 },
};

export class GeoArrowArcLayer<
  ExtraProps extends {} = {}
> extends CompositeLayer<Required<GeoArrowArcLayerProps> & ExtraProps> {
  static defaultProps = defaultProps;
  static layerName = "GeoArrowArcLayer";

  getPickingInfo({
    info,
    sourceLayer,
  }: GetPickingInfoParams): GeoArrowPickingInfo {
    const { data: table } = this.props;

    // Geometry index as rendered
    let index = info.index;

    // @ts-expect-error `recordBatchIdx` is manually set on layer props
    const recordBatchIdx: number = sourceLayer.props.recordBatchIdx;
    const batch = table.batches[recordBatchIdx];
    const row = batch.get(index);

    // @ts-expect-error hack: using private method to avoid recomputing via
    // batch lengths on each iteration
    const offsets: number[] = table._offsets;
    const currentBatchOffset = offsets[recordBatchIdx];

    // Update index to be _global_ index, not within the specific record batch
    index += currentBatchOffset;
    return {
      ...info,
      index,
      object: row,
    };
  }

  renderLayers(): Layer<{}> | LayersList | null {
    return this._renderLayersPoint();
  }

  _renderLayersPoint(): Layer<{}> | LayersList | null {
    const {
      data: table,
      getSourcePosition: sourcePosition,
      getTargetPosition: targetPosition,
    } = this.props;

    if (this.props._validate) {
      const vectorAccessors: arrow.Vector[] = [sourcePosition, targetPosition];
      for (const accessor of [
        this.props.getSourceColor,
        this.props.getTargetColor,
        this.props.getWidth,
        this.props.getHeight,
        this.props.getTilt,
      ]) {
        if (accessor instanceof arrow.Vector) {
          vectorAccessors.push(accessor);
        }
      }

      validatePointType(sourcePosition.type);
      validatePointType(targetPosition.type);
      if (table) {
        validateVectorAccessors(table, vectorAccessors);
      } else {
        const validationTable = new arrow.Table({
          source: sourcePosition,
          target: targetPosition,
        });
        validateVectorAccessors(validationTable, vectorAccessors);
      }

      if (this.props.getSourceColor instanceof arrow.Vector) {
        validateColorVector(this.props.getSourceColor);
      }
      if (this.props.getTargetColor instanceof arrow.Vector) {
        validateColorVector(this.props.getTargetColor);
      }
    }

    const layers: ArcLayer[] = [];
    for (
      let recordBatchIdx = 0;
      recordBatchIdx < table.batches.length;
      recordBatchIdx++
    ) {
      const sourceData = sourcePosition.data[recordBatchIdx];
      const sourceValues = getPointChild(sourceData).values;
      const targetData = targetPosition.data[recordBatchIdx];
      const targetValues = getPointChild(targetData).values;

      const props: ArcLayerProps = {
        // @ts-expect-error used for picking purposes
        recordBatchIdx,

        id: `${this.props.id}-geoarrow-arc-${recordBatchIdx}`,

        greatCircle: this.props.greatCircle,
        numSegments: this.props.numSegments,
        widthUnits: this.props.widthUnits,
        widthScale: this.props.widthScale,
        widthMinPixels: this.props.widthMinPixels,
        widthMaxPixels: this.props.widthMaxPixels,

        data: {
          length: sourceData.length,
          attributes: {
            getSourcePosition: {
              value: sourceValues,
              size: sourceData.type.listSize,
            },
            getTargetPosition: {
              value: targetValues,
              size: targetData.type.listSize,
            },
          },
        },
      };

      assignAccessor({
        props,
        propName: "getSourceColor",
        propInput: this.props.getSourceColor,
        chunkIdx: recordBatchIdx,
      });
      assignAccessor({
        props,
        propName: "getTargetColor",
        propInput: this.props.getTargetColor,
        chunkIdx: recordBatchIdx,
      });
      assignAccessor({
        props,
        propName: "getWidth",
        propInput: this.props.getWidth,
        chunkIdx: recordBatchIdx,
      });
      assignAccessor({
        props,
        propName: "getHeight",
        propInput: this.props.getHeight,
        chunkIdx: recordBatchIdx,
      });
      assignAccessor({
        props,
        propName: "getTilt",
        propInput: this.props.getTilt,
        chunkIdx: recordBatchIdx,
      });

      const layer = new ArcLayer(this.getSubLayerProps(props));
      layers.push(layer);
    }

    return layers;
  }
}

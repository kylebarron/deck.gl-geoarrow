import {
  Accessor,
  Color,
  CompositeLayer,
  CompositeLayerProps,
  Material,
  DefaultProps,
  Layer,
  LayersList,
  GetPickingInfoParams,
  PickingInfo,
} from "@deck.gl/core/typed";
import { SolidPolygonLayer } from "@deck.gl/layers/typed";
import type { SolidPolygonLayerProps } from "@deck.gl/layers/typed";
import * as arrow from "apache-arrow";
import {
  assignAccessor,
  getGeometryVector,
  getLineStringChild,
  getMultiPolygonChild,
  getMultiPolygonResolvedOffsets,
  getPointChild,
  getPolygonChild,
  getPolygonResolvedOffsets,
  invertOffsets,
  isMultiPolygonVector,
  isPolygonVector,
  validateColorVector,
  validateMultiPolygonType,
  validatePolygonType,
  validateVectorAccessors,
} from "./utils.js";
import {
  GeoArrowPickingInfo,
  MultiPolygonVector,
  PolygonVector,
} from "./types.js";
import { EXTENSION_NAME } from "./constants.js";

const DEFAULT_COLOR: [number, number, number, number] = [0, 0, 0, 255];

/** All properties supported by GeoArrowSolidPolygonLayer */
export type GeoArrowSolidPolygonLayerProps = _GeoArrowSolidPolygonLayerProps &
  CompositeLayerProps;

/** Properties added by GeoArrowSolidPolygonLayer */
type _GeoArrowSolidPolygonLayerProps = {
  data: arrow.Table;

  /** Whether to fill the polygons
   * @default true
   */
  filled?: boolean;
  /** Whether to extrude the polygons
   * @default false
   */
  extruded?: boolean;
  /** Whether to generate a line wireframe of the polygon.
   * @default false
   */
  wireframe?: boolean;
  /**
   * (Experimental) If `false`, will skip normalizing the coordinates returned by `getPolygon`.
   * @default true
   */
  _normalize?: boolean;
  /**
   * (Experimental) This prop is only effective with `_normalize: false`.
   * It specifies the winding order of rings in the polygon data, one of 'CW' (clockwise) and 'CCW' (counter-clockwise)
   */
  _windingOrder?: "CW" | "CCW";

  /**
   * (Experimental) This prop is only effective with `XYZ` data.
   * When true, polygon tesselation will be performed on the plane with the largest area, instead of the xy plane.
   * @default false
   */
  _full3d?: boolean;

  /**
   * If `true`, validate the arrays provided (e.g. chunk lengths)
   * @default true
   */
  _validate?: boolean;

  /** Elevation multiplier.
   * @default 1
   */
  elevationScale?: number;

  /** Polygon geometry accessor. */
  getPolygon?: PolygonVector | MultiPolygonVector;

  /** Extrusion height accessor.
   * @default 1000
   */
  getElevation?: arrow.Vector<arrow.Float> | Accessor<arrow.Table, number>;
  /** Fill color accessor.
   * @default [0, 0, 0, 255]
   */
  getFillColor?:
    | arrow.Vector<arrow.FixedSizeList<arrow.Uint8>>
    | Accessor<arrow.Table, Color>;
  /** Stroke color accessor.
   * @default [0, 0, 0, 255]
   */
  getLineColor?:
    | arrow.Vector<arrow.FixedSizeList<arrow.Uint8>>
    | Accessor<arrow.Table, Color>;

  /**
   * Material settings for lighting effect. Applies if `extruded: true`
   *
   * @default true
   * @see https://deck.gl/docs/developer-guide/using-lighting
   */
  material?: Material;
};

const defaultProps: DefaultProps<GeoArrowSolidPolygonLayerProps> = {
  filled: true,
  extruded: false,
  wireframe: false,
  // Note: this diverges from upstream, where here we default to no
  // normalization
  _normalize: false,
  // Note: this diverges from upstream, where here we default to CCW
  _windingOrder: "CCW",
  _full3d: false,
  _validate: true,

  elevationScale: { type: "number", min: 0, value: 1 },

  getElevation: { type: "accessor", value: 1000 },
  getFillColor: { type: "accessor", value: DEFAULT_COLOR },
  getLineColor: { type: "accessor", value: DEFAULT_COLOR },

  material: true,
};

export class GeoArrowSolidPolygonLayer<
  ExtraProps extends {} = {}
> extends CompositeLayer<
  Required<GeoArrowSolidPolygonLayerProps> & ExtraProps
> {
  static defaultProps = defaultProps;
  static layerName = "GeoArrowSolidPolygonLayer";

  getPickingInfo({
    info,
    sourceLayer,
  }: GetPickingInfoParams): GeoArrowPickingInfo {
    const { data: table } = this.props;

    // Geometry index as rendered
    let index = info.index;

    // if a MultiPolygon dataset, map from the rendered index back to the
    // feature index
    // @ts-expect-error `invertedGeomOffsets` is manually set on layer props
    if (sourceLayer.props.invertedGeomOffsets) {
      // @ts-expect-error `invertedGeomOffsets` is manually set on layer props
      index = sourceLayer.props.invertedGeomOffsets[index];
    }

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
    const { data: table } = this.props;

    const polygonVector = getGeometryVector(table, EXTENSION_NAME.POLYGON);
    if (polygonVector !== null) {
      return this._renderLayersPolygon(polygonVector);
    }

    const MultiPolygonVector = getGeometryVector(
      table,
      EXTENSION_NAME.MULTIPOLYGON
    );
    if (MultiPolygonVector !== null) {
      return this._renderLayersMultiPolygon(MultiPolygonVector);
    }

    const geometryColumn = this.props.getPolygon;
    if (isPolygonVector(geometryColumn)) {
      return this._renderLayersPolygon(geometryColumn);
    }

    if (isMultiPolygonVector(geometryColumn)) {
      return this._renderLayersMultiPolygon(geometryColumn);
    }

    throw new Error("geometryColumn not Polygon or MultiPolygon");
  }

  _renderLayersPolygon(
    geometryColumn: PolygonVector
  ): Layer<{}> | LayersList | null {
    const { data: table } = this.props;

    if (this.props._validate) {
      const vectorAccessors: arrow.Vector[] = [geometryColumn];
      for (const accessor of [
        this.props.getElevation,
        this.props.getFillColor,
        this.props.getLineColor,
      ]) {
        if (accessor instanceof arrow.Vector) {
          vectorAccessors.push(accessor);
        }
      }

      validatePolygonType(geometryColumn.type);
      validateVectorAccessors(table, vectorAccessors);

      if (this.props.getFillColor instanceof arrow.Vector) {
        validateColorVector(this.props.getFillColor);
      }
      if (this.props.getLineColor instanceof arrow.Vector) {
        validateColorVector(this.props.getLineColor);
      }
    }

    const layers: SolidPolygonLayer[] = [];
    for (
      let recordBatchIdx = 0;
      recordBatchIdx < table.batches.length;
      recordBatchIdx++
    ) {
      const polygonData = geometryColumn.data[recordBatchIdx];
      const ringData = getPolygonChild(polygonData);
      const pointData = getLineStringChild(ringData);
      const coordData = getPointChild(pointData);

      const nDim = pointData.type.listSize;

      // const geomOffsets = polygonData.valueOffsets;
      // const ringOffsets = ringData.valueOffsets;
      const flatCoordinateArray = coordData.values;

      const resolvedRingOffsets = getPolygonResolvedOffsets(polygonData);

      const props: SolidPolygonLayerProps = {
        // used for picking purposes
        recordBatchIdx,

        id: `${this.props.id}-geoarrow-point-${recordBatchIdx}`,
        filled: this.props.filled,
        extruded: this.props.extruded,
        wireframe: this.props.wireframe,
        _normalize: this.props._normalize,
        _windingOrder: this.props._windingOrder,
        _full3d: this.props._full3d,
        elevationScale: this.props.elevationScale,
        material: this.props.material,
        data: {
          // Number of geometries
          length: polygonData.length,
          // Offsets into coordinateArray where each polygon starts
          // @ts-ignore
          startIndices: resolvedRingOffsets,
          attributes: {
            getPolygon: { value: flatCoordinateArray, size: nDim },
          },
        },
      };

      assignAccessor({
        props,
        propName: "getElevation",
        propInput: this.props.getElevation,
        chunkIdx: recordBatchIdx,
        geomCoordOffsets: resolvedRingOffsets,
      });
      assignAccessor({
        props,
        propName: "getFillColor",
        propInput: this.props.getFillColor,
        chunkIdx: recordBatchIdx,
        geomCoordOffsets: resolvedRingOffsets,
      });
      assignAccessor({
        props,
        propName: "getLineColor",
        propInput: this.props.getLineColor,
        chunkIdx: recordBatchIdx,
        geomCoordOffsets: resolvedRingOffsets,
      });

      const layer = new SolidPolygonLayer(this.getSubLayerProps(props));
      layers.push(layer);
    }

    return layers;
  }

  _renderLayersMultiPolygon(
    geometryColumn: MultiPolygonVector
  ): Layer<{}> | LayersList | null {
    const { data: table } = this.props;

    if (this.props._validate) {
      const vectorAccessors: arrow.Vector[] = [geometryColumn];
      for (const accessor of [
        this.props.getElevation,
        this.props.getFillColor,
        this.props.getLineColor,
      ]) {
        if (accessor instanceof arrow.Vector) {
          vectorAccessors.push(accessor);
        }
      }

      validateMultiPolygonType(geometryColumn.type);
      validateVectorAccessors(table, vectorAccessors);

      if (this.props.getFillColor instanceof arrow.Vector) {
        validateColorVector(this.props.getFillColor);
      }
      if (this.props.getLineColor instanceof arrow.Vector) {
        validateColorVector(this.props.getLineColor);
      }
    }

    const layers: SolidPolygonLayer[] = [];
    for (
      let recordBatchIdx = 0;
      recordBatchIdx < table.batches.length;
      recordBatchIdx++
    ) {
      const multiPolygonData = geometryColumn.data[recordBatchIdx];
      const polygonData = getMultiPolygonChild(multiPolygonData);
      const ringData = getPolygonChild(polygonData);
      const pointData = getLineStringChild(ringData);
      const coordData = getPointChild(pointData);

      const nDim = pointData.type.listSize;

      const geomOffsets = multiPolygonData.valueOffsets;
      // const polygonOffsets = polygonData.valueOffsets;
      // const ringOffsets = ringData.valueOffsets;
      const flatCoordinateArray = coordData.values;

      // NOTE: we have two different uses of offsets. One is for _rendering_
      // each polygon. The other is for mapping _accessor attributes_ from one
      // value per feature to one value per vertex. And for that we need to use
      // these offsets in two different ways.
      //
      // TODO: Don't construct the offsets twice from scratch? I.e. from the
      // polygon-to-coord offsets you should be able to infer the
      // multi-polygon-to-coord offsets? Or something like that
      const resolvedPolygonToCoordOffsets =
        getPolygonResolvedOffsets(polygonData);

      const resolvedMultiPolygonToCoordOffsets =
        getMultiPolygonResolvedOffsets(multiPolygonData);

      const props: SolidPolygonLayerProps = {
        // used for picking purposes
        recordBatchIdx,
        invertedGeomOffsets: invertOffsets(geomOffsets),

        id: `${this.props.id}-geoarrow-point-${recordBatchIdx}`,
        filled: this.props.filled,
        extruded: this.props.extruded,
        wireframe: this.props.wireframe,
        _normalize: this.props._normalize,
        _windingOrder: this.props._windingOrder,
        _full3d: this.props._full3d,
        elevationScale: this.props.elevationScale,
        material: this.props.material,
        data: {
          // Number of polygons
          // Note: this needs to be the length one level down, because we're
          // rendering the polygons, not the multipolygons
          length: polygonData.length,
          // Offsets into coordinateArray where each single-polygon starts
          //
          // Note that this is polygonToCoordOffsets and not geomToCoordOffsets
          // because we're rendering each part of the MultiPolygon individually
          // @ts-expect-error
          startIndices: resolvedPolygonToCoordOffsets,
          attributes: {
            getPolygon: { value: flatCoordinateArray, size: nDim },
            instancePickingColors: {
              value: encodePickingColors(
                resolvedMultiPolygonToCoordOffsets,
                this.encodePickingColor
              ),
              size: 3,
            },
          },
        },
      };

      console.log(resolvedMultiPolygonToCoordOffsets);

      assignAccessor({
        props,
        propName: "getElevation",
        propInput: this.props.getElevation,
        chunkIdx: recordBatchIdx,
        geomCoordOffsets: resolvedMultiPolygonToCoordOffsets,
      });
      assignAccessor({
        props,
        propName: "getFillColor",
        propInput: this.props.getFillColor,
        chunkIdx: recordBatchIdx,
        geomCoordOffsets: resolvedMultiPolygonToCoordOffsets,
      });
      assignAccessor({
        props,
        propName: "getLineColor",
        propInput: this.props.getLineColor,
        chunkIdx: recordBatchIdx,
        geomCoordOffsets: resolvedMultiPolygonToCoordOffsets,
      });

      const layer = new SolidPolygonLayer(this.getSubLayerProps(props));
      layers.push(layer);
    }

    return layers;
  }
}

function encodePickingColors(
  geomToCoordOffsets: Int32Array,
  encodePickingColor: (id: number, result: number[]) => void
): Uint8ClampedArray {
  const largestOffset = geomToCoordOffsets[geomToCoordOffsets.length - 1];
  const pickingColors = new Uint8ClampedArray(largestOffset);

  const pickingColor = [];
  for (let arrayIdx = 0; arrayIdx < geomToCoordOffsets.length - 1; arrayIdx++) {
    const thisOffset = geomToCoordOffsets[arrayIdx];
    const nextOffset = geomToCoordOffsets[arrayIdx + 1];

    // Note: we encode the picking color once per _feature_, but then assign it
    // to the color array once per _vertex_
    encodePickingColor(arrayIdx, pickingColor);
    for (let offset = thisOffset; offset < nextOffset; offset++) {
      pickingColors[offset * 3] = pickingColor[0];
      pickingColors[offset * 3 + 1] = pickingColor[1];
      pickingColors[offset * 3 + 2] = pickingColor[2];
    }
  }

  console.log(pickingColors);
  return pickingColors;
}

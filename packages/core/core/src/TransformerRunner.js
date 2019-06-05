// @flow
import nullthrows from 'nullthrows';
import type {
  MutableAsset as IMutableAsset,
  Blob,
  ConfigRequest,
  File,
  FilePath,
  GenerateOutput,
  Transformer,
  AssetRequest,
  TransformerResult,
  ParcelOptions,
  PackageName
} from '@parcel/types';
import type {CacheEntry} from './types';

import path from 'path';
import clone from 'clone';
import {
  md5FromFilePath,
  md5FromReadableStream,
  md5FromString
} from '@parcel/utils';
import Cache from '@parcel/cache';
import {TapStream, unique} from '@parcel/utils';
import {createReadStream} from 'fs';

import Config from './Config';
import Dependency from './Dependency';
import type ParcelConfig from './ParcelConfig';
import ResolverRunner from './ResolverRunner';
import {report} from './ReporterRunner';
import {MutableAsset, assetToInternalAsset} from './public/Asset';
import InternalAsset from './Asset';
import type {NodeId} from './types';

type Opts = {|
  config: ParcelConfig,
  options: ParcelOptions
|};

type GenerateFunc = (input: IMutableAsset) => Promise<GenerateOutput>;

const BUFFER_LIMIT = 5000000; // 5mb

type TransformationOpts = {|
  request: AssetRequest,
  loadConfig: (ConfigRequest, NodeId) => Promise<Config>,
  parentNodeId: NodeId,
  options: ParcelOptions
|};

type ConfigCollection = {
  [PackageName]: any
};

export class Transformation {
  request: AssetRequest;
  loadConfig: ConfigRequest => Promise<Config>;
  options: ParcelOptions;

  constructor({
    request,
    loadConfig,
    parentNodeId,
    options
  }: TransformationOpts) {
    this.request = request;
    this.loadConfig = configRequest => loadConfig(configRequest, parentNodeId);
    this.options = options;
  }

  async run() {
    report({
      type: 'buildProgress',
      phase: 'transforming',
      request: this.request
    });

    console.log('IN TRANSFORMATION.RUN', this.request);
    let asset = await this.loadAsset();
    console.log('INITIAL ASSET', asset);

    return this.runPipeline(asset);
  }

  async loadAsset() {
    let {filePath, env, code, sideEffects} = this.request;
    let {content, size, hash} = await summarizeRequest(this.request);

    return new InternalAsset({
      // If the transformer request passed code rather than a filename,
      // use a hash as the base for the id to ensure it is unique.
      idBase: code ? hash : filePath,
      filePath: filePath,
      type: path.extname(filePath).slice(1),
      ast: null,
      content,
      hash,
      env: env,
      stats: {
        time: 0,
        size
      },
      sideEffects
    });
  }

  async runPipeline(initialAsset: InternalAsset) {
    let {pipeline, configs} = await this.loadPipeline(initialAsset.filePath);

    let cacheKey = this.getCacheKey(initialAsset, configs);
    console.log('CACHE KEY', cacheKey);
    let cacheEntry = await Cache.get(cacheKey);

    if (cacheEntry) console.log('CACHE ENTRY FOUND', cacheEntry);
    else console.log('TRANSFORMING');

    let assets = cacheEntry || (await pipeline.transform(initialAsset));

    let finalAssets = [];
    for (let asset of assets) {
      if (asset.type !== initialAsset.type) {
        let nextPipelineAssets = this.runPipeline(asset);
        finalAssets = finalAssets.concat(nextPipelineAssets);
      } else {
        finalAssets.push(asset);
      }
    }

    let processedFinalAssets = finalAssets;
    // pipeline.postProcess
    //   ? await pipeline.postProcess(assets)
    //   : finalAssets;

    Cache.set(cacheKey, processedFinalAssets);

    console.log('TRANSFORMATION RESULT', processedFinalAssets);

    return processedFinalAssets;
  }

  getCacheKey(asset: InternalAsset, configs: ConfigCollection) {
    let {filePath, content} = asset;
    return md5FromString(JSON.stringify({filePath, content, configs}));
  }

  async loadPipeline(filePath: FilePath) {
    let configRequest = {
      filePath,
      meta: {
        actionType: 'transformation'
      }
    };

    let config = await this.loadConfig(configRequest);
    let parcelConfig = nullthrows(config.result);

    let configs = {
      parcel: parcelConfig.getTransformerNames(filePath)
    };

    for (let [moduleName] of config.devDeps) {
      let plugin = await parcelConfig.result.loadPlugin(moduleName);
      // TODO: implement loadPlugin in existing plugins that require config
      if (plugin.loadConfig) {
        let thirdPartyConfigRequest = await this.loadTransformerConfig(
          filePath,
          moduleName,
          parcelConfig.resolvedPath
        );
        let thirdPartyConfig = nullthrows(thirdPartyConfigRequest.result);
        configs[moduleName] = thirdPartyConfig;
      }
    }

    let pipeline = new Pipeline(
      await parcelConfig.getTransformers(filePath),
      configs,
      this.options
    );

    return {pipeline, configs};
  }

  async loadTransformerConfig(
    filePath: FilePath,
    plugin: PackageName,
    parcelConfigPath: FilePath
  ) {
    let configRequest = {
      filePath,
      plugin,
      meta: {
        parcelConfigPath
      }
    };
    return this.loadConfig(configRequest);
  }
}

class Pipeline {
  transformers: Array<Transformer>;
  options: ParcelOptions;
  resolverRunner: ResolverRunner;

  constructor(
    transformers: Array<Transformer>,
    configs: ConfigCollection,
    options: ParcelOptions,
    config: ParcelConfig
  ) {
    this.transformers = transformers;
    this.options = options;
    this.resolverRunner = new ResolverRunner({
      config,
      options
    });
  }

  async transform(initialAsset: InternalAsset) {
    let inputAssets = [initialAsset];
    let resultingAssets;
    let finalAssets = [];
    for (let transformer of this.transformers) {
      resultingAssets = [];
      for (let asset of inputAssets) {
        if (asset.type !== initialAsset.type) {
          finalAssets.push(asset);
        } else {
          resultingAssets = resultingAssets.concat(
            await this.runTransformer(asset, transformer)
          );
        }
      }

      inputAssets = resultingAssets;
    }

    finalAssets = finalAssets.concat(resultingAssets);

    return finalAssets;
  }

  async runTransformer(asset: InternalAsset, transformer: Transformer) {
    const resolve = async (from: FilePath, to: string): Promise<FilePath> => {
      return (await this.resolverRunner.resolve(
        new Dependency({
          env: asset.env,
          moduleSpecifier: to,
          sourcePath: from
        })
      )).filePath;
    };

    // Load config for the transformer.
    let config = null;
    if (transformer.getConfig) {
      config = await transformer.getConfig({
        asset: new MutableAsset(asset),
        options: this.options,
        resolve
      });
    }

    // If an ast exists on the asset, but we cannot reuse it,
    // use the previous transform to generate code that we can re-parse.
    if (
      asset.ast &&
      (!transformer.canReuseAST ||
        !transformer.canReuseAST({ast: asset.ast, options: this.options})) &&
      this.generate
    ) {
      let output = await this.generate(new MutableAsset(asset));
      asset.content = output.code;
      asset.ast = null;
    }

    // Parse if there is no AST available from a previous transform.
    if (!asset.ast && transformer.parse) {
      asset.ast = await transformer.parse({
        asset: new MutableAsset(asset),
        config,
        options: this.options
      });
    }

    // Transform.
    let results = await normalizeAssets(
      // $FlowFixMe
      await transformer.transform({
        asset: new MutableAsset(asset),
        config,
        options: this.options
      })
    );

    // Create generate and postProcess functions that can be called later
    this.generate = async (input: IMutableAsset): Promise<GenerateOutput> => {
      if (transformer.generate) {
        return transformer.generate({
          asset: input,
          config,
          options: this.options
        });
      }

      throw new Error(
        'Asset has an AST but no generate method is available on the transform'
      );
    };

    this.postProcess = async (
      assets: Array<InternalAsset>
    ): Promise<Array<InternalAsset> | null> => {
      let {postProcess} = transformer;
      if (postProcess) {
        let results = await postProcess({
          assets: assets.map(asset => new MutableAsset(asset)),
          config,
          options: this.options
        });

        return Promise.all(
          results.map(result => asset.createChildAsset(result))
        );
      }

      return null;
    };

    return results;
  }
}

export default class TransformerRunner {
  options: ParcelOptions;
  config: ParcelConfig;
  resolverRunner: ResolverRunner;

  constructor({config, options}: Opts) {
    this.options = options;
    this.config = config;
    this.resolverRunner = new ResolverRunner({
      config,
      options
    });
  }

  async transform(
    req: AssetRequest,
    loadConfig: () => Promise<Config>,
    parentNodeId: NodeId
  ): Promise<CacheEntry> {
    report({
      type: 'buildProgress',
      phase: 'transforming',
      request: req
    });

    let config = await this.loadConfig(req, loadConfig, parentNodeId);

    // If a cache entry matches, no need to transform.
    let cacheEntry;
    if (this.options.cache !== false && req.code == null) {
      cacheEntry = await Cache.get(reqCacheKey(req));
    }

    let {content, size, hash} = await summarizeRequest(req);
    if (
      cacheEntry &&
      cacheEntry.hash === hash &&
      (await checkCachedAssets(cacheEntry.assets))
    ) {
      return cacheEntry;
    }

    let input = new InternalAsset({
      // If the transformer request passed code rather than a filename,
      // use a hash as the base for the id to ensure it is unique.
      idBase: req.code ? hash : req.filePath,
      filePath: req.filePath,
      type: path.extname(req.filePath).slice(1),
      ast: null,
      content,
      hash,
      env: req.env,
      stats: {
        time: 0,
        size
      },
      sideEffects: req.sideEffects
    });

    let pipeline = await config.getTransformers(req.filePath);
    let {assets, initialAssets} = await this.runPipeline(
      input,
      pipeline,
      cacheEntry
    );

    cacheEntry = {
      filePath: req.filePath,
      env: req.env,
      hash,
      assets,
      initialAssets
    };

    await Promise.all(
      unique([...assets, ...(initialAssets || [])]).map(asset => asset.commit())
    );
    await Cache.set(reqCacheKey(req), cacheEntry);
    return cacheEntry;
  }

  async loadConfig(
    request: AssetRequest,
    loadConfig: (ConfigRequest, NodeId) => Promise<Config>,
    parentNodeId: NodeId
  ) {
    let configRequest = {
      filePath: request.filePath,
      meta: {
        pluginType: 'transformer'
      }
    };

    let config = await loadConfig(configRequest, parentNodeId);
    let parcelConfig = nullthrows(config.result);

    return parcelConfig;
  }

  async runPipeline(
    input: InternalAsset,
    pipeline: Array<Transformer>,
    cacheEntry: ?CacheEntry,
    previousGenerate: ?GenerateFunc
  ): Promise<{|
    assets: Array<InternalAsset>,
    initialAssets: ?Array<InternalAsset>
  |}> {
    // Run the first transformer in the pipeline.
    let {results, generate, postProcess} = await this.runTransform(
      input,
      pipeline[0],
      previousGenerate
    );

    let assets: Array<InternalAsset> = [];
    for (let result of results) {
      let asset = input.createChildAsset(result);

      // Check if any of the cached assets match the result.
      if (cacheEntry) {
        let cachedAssets: Array<InternalAsset> = (
          cacheEntry.initialAssets || cacheEntry.assets
        ).filter(child => child.hash && child.hash === asset.hash);

        if (
          cachedAssets.length > 0 &&
          (await checkCachedAssets(cachedAssets))
        ) {
          assets = assets.concat(cachedAssets);
          continue;
        }
      }

      // If the generated asset has the same type as the input...
      // TODO: this is incorrect since multiple file types could map to the same pipeline. need to compare the pipelines.
      if (result.type === input.type) {
        // If we have reached the last transform in the pipeline, then we are done.
        if (pipeline.length === 1) {
          assets.push(await finalize(asset, generate));
        } else {
          // Recursively run the remaining transforms in the pipeline.
          let nextPipelineResult = await this.runPipeline(
            asset,
            pipeline.slice(1),
            null,
            generate
          );

          assets = assets.concat(nextPipelineResult.assets);
        }
      } else {
        // Jump to a different pipeline for the generated asset.
        let nextFilePath =
          input.filePath.slice(0, -path.extname(input.filePath).length) +
          '.' +
          result.type;
        let nextPipelineResult = await this.runPipeline(
          asset,
          await this.config.getTransformers(nextFilePath),
          null,
          generate
        );

        assets = assets.concat(nextPipelineResult.assets);
      }
    }

    // If the transformer has a postProcess function, execute that with the result of the pipeline.
    let finalAssets = await postProcess(clone(assets));
    return {
      assets: finalAssets || assets,
      initialAssets: finalAssets ? assets : null
    };
  }

  async runTransform(
    input: InternalAsset,
    transformer: Transformer,
    previousGenerate: ?GenerateFunc
  ) {
    const resolve = async (from: FilePath, to: string): Promise<FilePath> => {
      return (await this.resolverRunner.resolve(
        new Dependency({
          env: input.env,
          moduleSpecifier: to,
          sourcePath: from
        })
      )).filePath;
    };

    // Load config for the transformer.
    let config = null;
    if (transformer.getConfig) {
      config = await transformer.getConfig({
        asset: new MutableAsset(input),
        options: this.options,
        resolve
      });
    }

    // If an ast exists on the input, but we cannot reuse it,
    // use the previous transform to generate code that we can re-parse.
    if (
      input.ast &&
      (!transformer.canReuseAST ||
        !transformer.canReuseAST({ast: input.ast, options: this.options})) &&
      previousGenerate
    ) {
      let output = await previousGenerate(new MutableAsset(input));
      input.content = output.code;
      input.ast = null;
    }

    // Parse if there is no AST available from a previous transform.
    if (!input.ast && transformer.parse) {
      input.ast = await transformer.parse({
        asset: new MutableAsset(input),
        config,
        options: this.options
      });
    }

    // Transform.
    let results = normalizeAssets(
      // $FlowFixMe
      await transformer.transform({
        asset: new MutableAsset(input),
        config,
        options: this.options
      })
    );

    // Create a generate function that can be called later to lazily generate
    let generate = async (input: IMutableAsset): Promise<GenerateOutput> => {
      if (transformer.generate) {
        return transformer.generate({
          asset: input,
          config,
          options: this.options
        });
      }

      throw new Error(
        'Asset has an AST but no generate method is available on the transform'
      );
    };

    // Create a postProcess function that can be called later
    let postProcess = async (
      assets: Array<InternalAsset>
    ): Promise<Array<InternalAsset> | null> => {
      let {postProcess} = transformer;
      if (postProcess) {
        let results = await postProcess({
          assets: assets.map(asset => new MutableAsset(asset)),
          config,
          options: this.options
        });

        return Promise.all(
          results.map(result => input.createChildAsset(result))
        );
      }

      return null;
    };

    return {results, generate, postProcess};
  }
}

async function finalize(
  asset: InternalAsset,
  generate: GenerateFunc
): Promise<InternalAsset> {
  if (asset.ast && generate) {
    let result = await generate(new MutableAsset(asset));
    asset.content = result.code;
    asset.map = result.map;
  }
  return asset;
}

async function checkCachedAssets(
  assets: Array<InternalAsset>
): Promise<boolean> {
  let results = await Promise.all(
    assets.map(asset => checkConnectedFiles(asset.getConnectedFiles()))
  );

  return results.every(Boolean);
}

async function checkConnectedFiles(files: Array<File>): Promise<boolean> {
  let hashes = await Promise.all(
    files.map(file => md5FromFilePath(file.filePath))
  );

  return files.every((file, index) => file.hash === hashes[index]);
}

function reqCacheKey(req: AssetRequest): string {
  return md5FromString(req.filePath + JSON.stringify(req.env));
}

async function summarizeRequest(
  req: AssetRequest
): Promise<{|content: Blob, hash: string, size: number|}> {
  let code = req.code;
  let content: Blob;
  let hash: string;
  let size: number;
  if (code == null) {
    // As an optimization for the common case of source code, while we read in
    // data to compute its md5 and size, buffer its contents in memory.
    // This avoids reading the data now, and then again during transformation.
    // If it exceeds BUFFER_LIMIT, throw it out and replace it with a stream to
    // lazily read it at a later point.
    content = Buffer.from([]);
    size = 0;
    hash = await md5FromReadableStream(
      createReadStream(req.filePath).pipe(
        new TapStream(buf => {
          size += buf.length;
          if (content instanceof Buffer) {
            if (size > BUFFER_LIMIT) {
              // if buffering this content would put this over BUFFER_LIMIT, replace
              // it with a stream
              content = createReadStream(req.filePath);
            } else {
              content = Buffer.concat([content, buf]);
            }
          }
        })
      )
    );
  } else {
    content = code;
    hash = md5FromString(code);
    size = Buffer.from(code).length;
  }

  return {content, hash, size};
}

function normalizeAssets(
  results: Array<TransformerResult | MutableAsset>
): Array<TransformerResult> {
  return results.map(result => {
    return result instanceof MutableAsset
      ? {
          type: result.type,
          content: assetToInternalAsset(result).content,
          ast: result.ast,
          // $FlowFixMe
          dependencies: result.getDependencies(),
          connectedFiles: result.getConnectedFiles(),
          // $FlowFixMe
          env: result.env,
          isIsolated: result.isIsolated,
          meta: result.meta
        }
      : result;
  });
}

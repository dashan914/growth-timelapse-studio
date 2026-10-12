"""Trusted local HQ worker. All paths are package-local, geometry is never decimated.

Original GLB mesh data is cached unchanged. Real sliced printer layers supply wall/infill beads; original full source
surfaces are clipped in the explicit printer plane. Missing cuts remain open.
Area lights and environment are artistic proxies, not recovered photo radiance.
"""
import json, math, pathlib, sys, time, traceback, struct, array, hashlib, shutil, re, os

MAX_PIXELS = 8388608
MAX_TRIANGLES = 5000000
PRINT_LAYOUT = {'positions':('float32','f',4,6),'tools':('uint16','H',2,1),'features':('uint8','B',1,1),'widths':('float32','f',4,1),'heights':('float32','f',4,1),'strokes':('uint32','I',4,1),'layers':('uint32','I',4,1),'layerHeights':('float64','d',8,1),'layerOffsets':('uint32','I',4,1),'layerSegments':('uint32','I',4,1)}

def load_print_layer(root, manifest):
    if manifest is None: return None
    if not isinstance(manifest,dict) or manifest.get('schemaVersion')!=1 or manifest.get('file')!='print-layer.bin' or manifest.get('source')!='sliced-gcode' or manifest.get('coordinates')!='printer-mm-z-up' or manifest.get('endianness')!='little' or manifest.get('exactLinearPaths') is not True or manifest.get('originalPathsUnmodified') is not True or manifest.get('crossSection') not in ('stadium-with-elliptical-fallback','elliptical-bead-12-sides'): raise ValueError('Invalid complete print-layer manifest')
    if sys.byteorder!='little': raise ValueError('Print-layer worker needs little-endian coordinates')
    count=int(finite(manifest.get('segmentCount'),'print segments',1,10000000)); layers=int(finite(manifest.get('layerCount'),'print layers',1,100000)); history=int(finite(manifest.get('historyLayers'),'print history',1,32))
    if any(not isinstance(manifest.get(name),int) or isinstance(manifest.get(name),bool) for name in ('segmentCount','layerCount','historyLayers')): raise ValueError('Print counts must be integers')
    if not isinstance(manifest.get('includeSupport'),bool): raise ValueError('Invalid print support selection')
    finite(manifest.get('arcToleranceMm'),'arc tolerance',.000001,.1)
    matrix=vector(manifest.get('printerToMetres'),'print mapping',16)
    det=matrix[0]*(matrix[5]*matrix[10]-matrix[9]*matrix[6])-matrix[4]*(matrix[1]*matrix[10]-matrix[9]*matrix[2])+matrix[8]*(matrix[1]*matrix[6]-matrix[5]*matrix[2])
    if abs(matrix[3])+abs(matrix[7])+abs(matrix[11])>1e-10 or abs(matrix[15]-1)>1e-10 or abs(det)<1e-24: raise ValueError('Print mapping must be explicit invertible affine')
    palette=manifest.get('palette'); colors={}
    if not isinstance(palette,list) or not 1<=len(palette)<=256: raise ValueError('Invalid print palette')
    if manifest.get('colorMode') not in ('source-or-tool-overrides','uniform-display') or manifest.get('colorMode')=='uniform-display' and not re.fullmatch(r'#[0-9a-fA-F]{6}',str(manifest.get('uniformColor',''))): raise ValueError('Invalid print display color mode')
    for item in palette:
        if not isinstance(item,dict) or not isinstance(item.get('tool'),int) or not 0<=item['tool']<=65535 or item['tool'] in colors or not re.fullmatch(r'#[0-9a-fA-F]{6}',str(item.get('color',''))): raise ValueError('Missing or duplicated print filament color')
        colors[item['tool']]=item['color']
        if manifest['colorMode']=='uniform-display' and item['color'].lower()!=manifest['uniformColor'].lower(): raise ValueError('Uniform CAD/bead color mismatch')
    filename=local_path(root,'print-layer.bin','print-layer',True)
    if filename.stat().st_size>536870912: raise ValueError('Print data budget exceeded; paths were not reduced')
    payload=filename.read_bytes(); view=memoryview(payload); arrays={}; size=0
    specs=manifest.get('arrays')
    if not isinstance(specs,dict) or set(specs)!=set(PRINT_LAYOUT): raise ValueError('Incomplete print attribute layout')
    for name,(kind,code,width,item_size) in PRINT_LAYOUT.items():
        expected=layers if name=='layerHeights' else layers+1 if name=='layerOffsets' else count; size=(size+7)//8*8
        spec=specs[name]
        if not isinstance(spec,dict) or spec.get('type')!=kind or spec.get('itemSize')!=item_size or spec.get('count')!=expected or spec.get('byteOffset')!=size or spec.get('byteLength')!=expected*item_size*width or size+spec['byteLength']>len(payload): raise ValueError('Print attribute span is inconsistent')
        arrays[name]=view[size:size+spec['byteLength']].cast(code); size+=spec['byteLength']
    if size!=len(payload) or arrays['layerOffsets'][0]!=0 or arrays['layerOffsets'][-1]!=count: raise ValueError('Incomplete full print index')
    seen=bytearray(count); maximum_window=0; active_prefix=[0]
    for layer in range(layers):
        z=arrays['layerHeights'][layer]; first,end=arrays['layerOffsets'][layer:layer+2]
        if not math.isfinite(z) or abs(z)>10000000 or layer and z<=arrays['layerHeights'][layer-1] or first>=end or end>count: raise ValueError('Invalid deposited layer index')
        active=0
        for index in range(first,end):
            segment=arrays['layerSegments'][index]
            if segment>=count or seen[segment] or arrays['layers'][segment]!=layer: raise ValueError('Print index repeats, omits or misplaces a segment')
            seen[segment]=1
            feature=arrays['features'][segment]
            if 1<=feature<=9 or feature==16 or manifest['includeSupport'] and feature in (10,11): active+=1
            if abs(max(arrays['positions'][segment*6+2],arrays['positions'][segment*6+5])-z)>.0003: raise ValueError('Print segment does not match deposited Z')
        active_prefix.append(active_prefix[-1]+active); maximum_window=max(maximum_window,active_prefix[-1]-active_prefix[max(0,layer-history+1)])
    if maximum_window>100000 or manifest.get('maxWindowSegments')!=maximum_window: raise ValueError('Print layer window exceeds full rendering budget; no paths omitted')
    model_segments=0; support_segments=0
    for segment in range(count):
        feature=arrays['features'][segment]; model=1<=feature<=9 or feature==16; support=feature in (10,11)
        if arrays['tools'][segment] not in colors or not (model or support): raise ValueError('Missing filament color or unsupported model feature')
        if model: model_segments+=1
        else: support_segments+=1
        finite(arrays['widths'][segment],'actual bead width',.000001,100); finite(arrays['heights'][segment],'actual bead height',.000001,100)
        for value in arrays['positions'][segment*6:segment*6+6]: finite(value,'actual printer coordinate',-10000000,10000000)
        if math.hypot(arrays['positions'][segment*6+3]-arrays['positions'][segment*6],arrays['positions'][segment*6+4]-arrays['positions'][segment*6+1])<1e-10: raise ValueError('Zero-length print extrusion')
    if manifest.get('modelSegments')!=model_segments or manifest.get('supportSegments')!=support_segments or not model_segments: raise ValueError('Model/support segment counts changed')
    if manifest['includeSupport'] and support_segments: raise ValueError('HQ cannot fully preserve historical support paths; disable support or use realtime')
    return {'manifest':manifest,'arrays':arrays,'colors':colors,'matrix':matrix,'count':count,'layers':layers,'history':history}

def geometry_signature(mesh):
    """Verify source positions, topology, normals and material regions, not just count."""
    digest=hashlib.sha256()
    for collection,field,kind,count in [(mesh.vertices,'co','f',len(mesh.vertices)*3),(mesh.loops,'vertex_index','i',len(mesh.loops)),(mesh.polygons,'material_index','i',len(mesh.polygons)),(mesh.corner_normals,'vector','f',len(mesh.corner_normals)*3)]:
        values=array.array(kind,[0])*count
        collection.foreach_get(field,values)
        digest.update(values.tobytes())
    for attribute in mesh.color_attributes:
        values=array.array('f',[0])*len(attribute.data)*4; attribute.data.foreach_get('color',values); digest.update(values.tobytes())
    return digest.hexdigest()

def finite(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(name + ' is outside the supported range')
    return float(value)

def vector(value, name, count=3):
    if not isinstance(value, list) or len(value) != count:
        raise ValueError(name + ' has an invalid dimension')
    return [finite(item, name, -1000000, 1000000) for item in value]

def local_path(root, value, name, required=False):
    if not isinstance(value, str) or not value or len(value) > 240:
        raise ValueError(name + ' is not a package path')
    relative = pathlib.Path(value)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError(name + ' must stay inside the package')
    candidate = (root / relative).resolve()
    if root not in candidate.parents or candidate == root:
        raise ValueError(name + ' must stay inside the package')
    if required and not candidate.is_file():
        raise ValueError(name + ' was not found')
    return candidate

def validate_config(config_path):
    config_path = pathlib.Path(config_path).resolve(strict=True)
    if config_path.stat().st_size > 262144:
        raise ValueError('Configuration is too large')
    root = config_path.parent
    config = json.loads(config_path.read_text(encoding='utf8'))
    if config.get('schemaVersion') != 1 or config.get('coordinateSystem', 'three-y-up') != 'three-y-up':
        raise ValueError('Unsupported scene package version or coordinates')
    scene_path = local_path(root, config.get('sceneFile', config.get('scene','scene.glb')), 'sceneFile', True)
    if scene_path.suffix.lower() != '.glb' or scene_path.stat().st_size > 536870912:
        raise ValueError('sceneFile must be a bounded GLB')
    with scene_path.open('rb') as stream:
        header=stream.read(20)
        if len(header)!=20 or header[:4]!=b'glTF' or struct.unpack('<I',header[4:8])[0]!=2 or header[16:20]!=b'JSON': raise ValueError('Invalid GLB header')
        json_length=struct.unpack('<I',header[12:16])[0]
        if json_length>67108864: raise ValueError('GLB JSON resource budget exceeded')
        gltf=json.loads(stream.read(json_length))
    for resource in gltf.get('buffers',[])+gltf.get('images',[]):
        if resource.get('uri') and not resource['uri'].startswith('data:'): raise ValueError('GLB external resources are not permitted')
    for node in gltf.get('nodes',[]):
        attributes=node.get('extensions',{}).get('EXT_mesh_gpu_instancing',{}).get('attributes',{})
        if '_COLOR_0' in attributes: raise ValueError('Blender importer cannot preserve per-instance support colors')
    for material in gltf.get('materials',[]):
        volume=material.get('extensions',{}).get('KHR_materials_volume',{})
        if volume.get('thicknessFactor',0)>0: raise ValueError('Volume glass needs density clipping; use the realtime renderer for this source')
    photo_path = None
    photo_file=config.get('photoFile',config.get('background',{}).get('file'))
    if photo_file:
        photo_path = local_path(root, photo_file, 'photoFile', True)
        if photo_path.suffix.lower() not in ('.png', '.jpg', '.jpeg') or photo_path.stat().st_size > 67108864:
            raise ValueError('photoFile must be a bounded PNG or JPEG')
    out = config.get('output', {})
    for name, low, high in [('width',64,4096),('height',64,4096),('fps',1,60),('frames',1,72000)]:
        finite(out.get(name), 'output.'+name, low, high)
        if not isinstance(out[name], int): raise ValueError('output.'+name+' must be integer')
    if out['width'] * out['height'] > MAX_PIXELS: raise ValueError('Output pixel budget exceeded')
    growth_frames = out.get('growthFrames', out['frames'])
    if isinstance(growth_frames, bool) or not isinstance(growth_frames,int) or not 1 <= growth_frames <= out['frames']:
        raise ValueError('output.growthFrames is invalid')
    out['growthFrames'] = growth_frames
    if 'previewProgress' in out:
        out['previewProgress']=finite(out['previewProgress'],'output.previewProgress',0,1)
        if out['frames']!=1 or growth_frames!=1 or out['fps']!=1 or out.get('samples',64)!=64 or 'durationSeconds' in out or 'growthSeconds' in out:
            raise ValueError('Current-frame preview requires one frame, one growth frame, 1 fps, 64 samples and no video timing')
    if 'durationSeconds' in out or 'growthSeconds' in out:
        duration=finite(out.get('durationSeconds'),'output.durationSeconds',.0001,1200)
        growth=finite(out.get('growthSeconds'),'output.growthSeconds',.0001,duration)
        out['durationSeconds']=duration; out['growthSeconds']=growth
    if out.get('samples',64) not in (64,128): raise ValueError('Samples must be 64 or 128')
    out['samples'] = out.get('samples',64)
    output_path = local_path(root, out.get('directory','frames'), 'output.directory')
    if output_path.exists() and not output_path.is_dir(): raise ValueError('Output path is not a directory')
    camera = config.get('camera', {})
    vector(camera.get('position'), 'camera.position')
    quaternion = vector(camera.get('quaternion'), 'camera.quaternion', 4)
    if sum(value*value for value in quaternion) < 1e-12: raise ValueError('Camera quaternion is zero')
    finite(camera.get('fov'), 'camera.fov', 3,145)
    if camera.get('projectionMatrix') is not None: vector(camera['projectionMatrix'], 'camera.projectionMatrix',16)
    if 'effectiveSensorHeightMm' in camera or 'physicalFocalLengthMm' in camera:
        sensor=finite(camera.get('effectiveSensorHeightMm'),'camera.effectiveSensorHeightMm',.001,100); lens=finite(camera.get('physicalFocalLengthMm'),'camera.physicalFocalLengthMm',.001,10000)
        if camera.get('projectionMatrix') and abs(2*lens/sensor-camera['projectionMatrix'][5])>1e-6: raise ValueError('Lens and active digital sensor do not match projection')
    plane = config.get('plane', {})
    finite(plane.get('widthM'), 'plane.widthM', .0001,100)
    finite(plane.get('depthM'), 'plane.depthM', .0001,100)
    finite(plane.get('yM',0), 'plane.yM', -100,100)
    bounds = config.get('bounds', {})
    finite(bounds.get('minY'), 'bounds.minY', -100,100)
    finite(bounds.get('maxY'), 'bounds.maxY', -100,100)
    if bounds['maxY'] <= bounds['minY']: raise ValueError('Growth bounds have no height')
    for name in ('lighting','grading','surface','dof'):
        if name in config and not isinstance(config[name],dict): raise ValueError(name+' must be an object')
    if 'fStop' in config.get('dof',{}): finite(config['dof']['fStop'],'dof.fStop',.7,64)
    surface = config.get('surface',{})
    if surface.get('printCoordinatesMatrix') is not None: vector(surface['printCoordinatesMatrix'],'surface.printCoordinatesMatrix',16)
    for name, fallback in [('layerHeightM',.0002),('firstLayerHeightM',.0002),('lineWidthM',.00042)]:
        if surface.get('enabled'): finite(surface.get(name,fallback),'surface.'+name,.000001,.01)
    config['_paths'] = {'root':root,'scene':scene_path,'photo':photo_path,'output':output_path}
    config['_print']=load_print_layer(root,config.get('printLayer'))
    return config

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, allow_nan=False), flush=True)

def growth_at_frame(index,output):
    if 'previewProgress' in output: return output['previewProgress']
    if output['frames']==1: return 1
    if 'durationSeconds' in output:
        time_seconds=index/(output['frames']-1)*output['durationSeconds']
        return min(1,time_seconds/output['growthSeconds'])
    return 1 if output['growthFrames']==1 else min(1,index/(output['growthFrames']-1))

def write_completion_stats(output_path, stats, output):
    if 'previewProgress' in output:
        stats={**stats,'previewProgress':output['previewProgress']}
    (output_path/'stats.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf8')
    emit({'type':'complete','stats':stats})

def setting(group, name, fallback, low, high):
    value = group.get(name, fallback)
    return finite(value, name, low, high)

def kelvin_rgb(temperature):
    value = temperature / 100
    r = 255 if value <= 66 else 329.698727446 * (value-60)**-.1332047592
    g = 99.4708025861*math.log(value)-161.1195681661 if value <= 66 else 288.1221695283*(value-60)**-.0755148492
    b = 255 if value >= 66 else 0 if value <= 19 else 138.5177312231*math.log(value-10)-305.0447927307
    encoded = [max(0,min(255,channel))/255 for channel in (r,g,b)]
    return tuple(channel/12.92 if channel <= .04045 else ((channel+.055)/1.055)**2.4 for channel in encoded)

def hex_linear(value, fallback):
    if not isinstance(value,str) or len(value)!=7 or value[0]!='#': value=fallback
    try: encoded=[int(value[index:index+2],16)/255 for index in (1,3,5)]
    except ValueError: raise ValueError('Color must be a six-digit hexadecimal value')
    return tuple(channel/12.92 if channel<=.04045 else ((channel+.055)/1.055)**2.4 for channel in encoded)

def compositor_tree(scene):
    return scene.compositing_node_group if hasattr(scene, 'compositing_node_group') else scene.node_tree


def compositor_node_type(scene, legacy):
    if hasattr(scene, 'compositing_node_group'):
        return {'CompositorNodeMath':'ShaderNodeMath', 'CompositorNodeMixRGB':'ShaderNodeMixRGB'}.get(legacy, legacy)
    return legacy


def set_alpha_conversion(node, mode):
    if hasattr(node, 'mapping'): node.mapping=mode
    else: node.inputs['Type'].default_value='To Straight' if mode=='PREMUL_TO_STRAIGHT' else 'To Premultiplied'


def select_cycles_devices(scene, prefs, requested=None):
    requested = (requested or os.environ.get('GROWTH_CYCLES_DEVICE', 'AUTO')).upper()
    if requested not in ('AUTO', 'CPU', 'OPTIX', 'CUDA', 'METAL', 'HIP', 'ONEAPI'):
        raise ValueError('Invalid GROWTH_CYCLES_DEVICE')
    scene.cycles.device = 'CPU'
    if requested == 'CPU': return []
    backends = ('OPTIX', 'CUDA', 'METAL', 'HIP', 'ONEAPI') if requested == 'AUTO' else (requested,)
    for backend in backends:
        try:
            prefs.compute_device_type = backend
            prefs.get_devices()
            devices = [device for device in prefs.devices if device.type == backend]
            if not devices: continue
            for device in prefs.devices: device.use = device.type == backend
            scene.cycles.device = 'GPU'
            return [{'name': device.name, 'type': device.type} for device in devices]
        except (TypeError, ValueError, RuntimeError):
            if requested != 'AUTO': raise
    if requested != 'AUTO': raise RuntimeError('Requested Cycles device is unavailable: ' + requested)
    return []


def build_model_grade(scene, rendered_socket, grade, exposure):
    """Model RGBA only. Black shadow pixels and alpha remain untouched."""
    tree = compositor_tree(scene)
    nodes, links = tree.nodes, tree.links
    def math_node(operation, *inputs):
        node = nodes.new(compositor_node_type(scene,'CompositorNodeMath')); node.operation = operation
        for index,value in enumerate(inputs):
            if isinstance(value,(int,float)): node.inputs[index].default_value = value
            else: links.new(value,node.inputs[index])
        return node.outputs[0]
    def clamp(value): return math_node('MINIMUM',math_node('MAXIMUM',value,0),1)
    def smooth(low,high,value):
        x=clamp(math_node('DIVIDE',math_node('SUBTRACT',value,low),high-low))
        return math_node('MULTIPLY',math_node('MULTIPLY',x,x),math_node('SUBTRACT',3,math_node('MULTIPLY',2,x)))
    unpremul=nodes.new('CompositorNodePremulKey'); set_alpha_conversion(unpremul,'PREMUL_TO_STRAIGHT')
    links.new(rendered_socket,unpremul.inputs[0])
    separate=nodes.new('CompositorNodeSeparateColor'); separate.mode='RGB'; links.new(unpremul.outputs[0],separate.inputs[0])
    colors=[]
    for channel in range(3):
        x=math_node('MULTIPLY',separate.outputs[channel],exposure)
        # Restrained local ACES fit. This curve never touches the photograph.
        top=math_node('MULTIPLY',x,math_node('ADD',math_node('MULTIPLY',2.51,x),.03))
        bottom=math_node('ADD',math_node('MULTIPLY',x,math_node('ADD',math_node('MULTIPLY',2.43,x),.59)),.14)
        colors.append(clamp(math_node('DIVIDE',top,bottom)))
    tint=setting(grade,'tint',0,-100,100)/100
    if tint:
        original_luma=math_node('ADD',math_node('ADD',math_node('MULTIPLY',colors[0],.2126),math_node('MULTIPLY',colors[1],.7152)),math_node('MULTIPLY',colors[2],.0722))
        adjusted=[math_node('MULTIPLY',value,2**((-1 if index==1 else 1)*tint*.5)) for index,value in enumerate(colors)]
        adjusted_luma=math_node('ADD',math_node('ADD',math_node('MULTIPLY',adjusted[0],.2126),math_node('MULTIPLY',adjusted[1],.7152)),math_node('MULTIPLY',adjusted[2],.0722))
        scale=math_node('DIVIDE',original_luma,math_node('MAXIMUM',adjusted_luma,1e-6))
        colors=[clamp(math_node('MULTIPLY',value,scale)) for value in adjusted]
    shadows=setting(grade,'shadows',0,-100,100)/100; highlights=setting(grade,'highlights',0,-100,100)/100
    if shadows or highlights:
        luma=math_node('ADD',math_node('ADD',math_node('MULTIPLY',colors[0],.2126),math_node('MULTIPLY',colors[1],.7152)),math_node('MULTIPLY',colors[2],.0722))
        gain=math_node('POWER',2,math_node('MULTIPLY',2,math_node('ADD',math_node('MULTIPLY',shadows,math_node('SUBTRACT',1,smooth(.12,.5,luma))),math_node('MULTIPLY',highlights,smooth(.45,.9,luma)))))
        adjusted=math_node('DIVIDE',math_node('MULTIPLY',luma,gain),math_node('MAXIMUM',math_node('ADD',math_node('SUBTRACT',1,luma),math_node('MULTIPLY',luma,gain)),1e-6))
        scale=math_node('DIVIDE',adjusted,math_node('MAXIMUM',luma,1e-6))
        colors=[clamp(math_node('MULTIPLY',value,scale)) for value in colors]
    contrast=setting(grade,'contrast',0,-100,100)/100
    if contrast:
        exponent=2**(.8*contrast); contrasted=[]
        for value in colors:
            lower=math_node('MULTIPLY',.18,math_node('POWER',math_node('DIVIDE',value,.18),exponent))
            upper=math_node('SUBTRACT',1,math_node('MULTIPLY',.82,math_node('POWER',math_node('DIVIDE',math_node('SUBTRACT',1,value),.82),exponent)))
            condition=math_node('LESS_THAN',value,.18)
            contrasted.append(clamp(math_node('ADD',math_node('MULTIPLY',lower,condition),math_node('MULTIPLY',upper,math_node('SUBTRACT',1,condition)))))
        colors=contrasted
    saturation=setting(grade,'saturation',0,-100,100)/100
    if saturation:
        luma=math_node('ADD',math_node('ADD',math_node('MULTIPLY',colors[0],.2126),math_node('MULTIPLY',colors[1],.7152)),math_node('MULTIPLY',colors[2],.0722))
        colors=[clamp(math_node('ADD',luma,math_node('MULTIPLY',math_node('SUBTRACT',value,luma),1+saturation))) for value in colors]
    combine=nodes.new('CompositorNodeCombineColor'); combine.mode='RGB'
    for index,value in enumerate(colors): links.new(value,combine.inputs[index])
    links.new(separate.outputs[3],combine.inputs[3])
    premul=nodes.new('CompositorNodePremulKey'); set_alpha_conversion(premul,'STRAIGHT_TO_PREMUL'); links.new(combine.outputs[0],premul.inputs[0])
    return premul.outputs[0]

def add_fdm(material, surface):
    if not surface.get('enabled') or not material.use_nodes: return
    nodes,links=material.node_tree.nodes,material.node_tree.links
    for bsdf in [node for node in nodes if node.type=='BSDF_PRINCIPLED']:
        detail=setting(surface,'detail',.6,0,1)
        coordinate=nodes.new('ShaderNodeNewGeometry'); xyz=nodes.new('ShaderNodeSeparateXYZ'); links.new(coordinate.outputs['Position'],xyz.inputs[0])
        coordinate_outputs=[xyz.outputs[index] for index in range(3)]
        matrix=surface.get('printCoordinatesMatrix')
        if matrix:
            transformed=[]
            for row in range(3):
                value=None
                for column in range(3):
                    multiply=nodes.new('ShaderNodeMath'); multiply.operation='MULTIPLY'; multiply.inputs[1].default_value=matrix[column*4+row]; links.new(coordinate_outputs[column],multiply.inputs[0])
                    if value is None: value=multiply.outputs[0]
                    else:
                        addition=nodes.new('ShaderNodeMath'); addition.operation='ADD'; links.new(value,addition.inputs[0]); links.new(multiply.outputs[0],addition.inputs[1]); value=addition.outputs[0]
                translation=nodes.new('ShaderNodeMath'); translation.operation='ADD'; translation.inputs[1].default_value=matrix[12+row]; links.new(value,translation.inputs[0]); transformed.append(translation.outputs[0])
            coordinate_outputs=transformed
        start=nodes.new('ShaderNodeMath'); start.operation='SUBTRACT'; start.inputs[1].default_value=surface.get('firstLayerHeightM',surface.get('layerHeightM',.0002)); links.new(coordinate_outputs[1],start.inputs[0])
        phase=nodes.new('ShaderNodeMath'); phase.operation='MULTIPLY'; phase.inputs[1].default_value=2*math.pi/surface.get('layerHeightM',.0002)
        links.new(start.outputs[0],phase.inputs[0])
        bead=nodes.new('ShaderNodeMath'); bead.operation='SINE'; links.new(phase.outputs[0],bead.inputs[0])
        bump=nodes.new('ShaderNodeBump'); bump.inputs['Strength'].default_value=.35*detail; bump.inputs['Distance'].default_value=.000012
        links.new(bead.outputs[0],bump.inputs['Height'])
        if bsdf.inputs['Normal'].is_linked: links.new(bsdf.inputs['Normal'].links[0].from_socket,bump.inputs['Normal'])
        links.new(bump.outputs[0],bsdf.inputs['Normal'])
        noise=nodes.new('ShaderNodeTexNoise'); noise.inputs['Scale'].default_value=8000; noise.inputs['Detail'].default_value=2
        combined=nodes.new('ShaderNodeCombineXYZ')
        for index,value in enumerate(coordinate_outputs): links.new(value,combined.inputs[index])
        links.new(combined.outputs[0],noise.inputs['Vector'])
        multiply=nodes.new('ShaderNodeMath'); multiply.operation='MULTIPLY'; multiply.inputs[1].default_value=.08*detail
        links.new(noise.outputs['Fac'],multiply.inputs[0])
        offset=nodes.new('ShaderNodeMath'); offset.operation='ADD'; offset.inputs[1].default_value=1-.04*detail; links.new(multiply.outputs[0],offset.inputs[0])
        rough=nodes.new('ShaderNodeMath'); rough.operation='MULTIPLY'
        roughness=bsdf.inputs['Roughness']; preset=surface.get('preset','auto')
        if preset=='auto' and roughness.is_linked: links.new(roughness.links[0].from_socket,rough.inputs[0])
        else: rough.inputs[0].default_value={'pla':.64,'matte':.88,'silk':.30,'petg':.38}.get(preset,roughness.default_value)
        links.new(offset.outputs[0],rough.inputs[1]); links.new(rough.outputs[0],roughness)

def source_height_clip(material, height, print_inverse=None):
    """Keep every original triangle/normal/map; clip all camera and shadow rays."""
    import bpy
    if not material.use_nodes: material.use_nodes=True
    nodes,links=material.node_tree.nodes,material.node_tree.links
    output=next((node for node in nodes if node.type=='OUTPUT_MATERIAL' and node.is_active_output),None)
    if not output or not output.inputs['Surface'].is_linked: raise ValueError('Source material surface cannot be clipped without replacing it')
    if output.inputs['Volume'].is_linked: raise ValueError('Volume shaders need density clipping; source material was not replaced')
    original=output.inputs['Surface'].links[0].from_socket
    geometry=nodes.new('ShaderNodeNewGeometry'); separate=nodes.new('ShaderNodeSeparateXYZ'); links.new(geometry.outputs['Position'],separate.inputs[0])
    value=separate.outputs['Y']
    if print_inverse is not None:
        value=None
        for axis in range(3):
            term=nodes.new('ShaderNodeMath'); term.operation='MULTIPLY'; term.inputs[1].default_value=print_inverse[2][axis]; links.new(separate.outputs[axis],term.inputs[0])
            if value is None: value=term.outputs[0]
            else:
                add=nodes.new('ShaderNodeMath'); add.operation='ADD'; links.new(value,add.inputs[0]); links.new(term.outputs[0],add.inputs[1]); value=add.outputs[0]
        offset=nodes.new('ShaderNodeMath'); offset.operation='ADD'; offset.inputs[1].default_value=print_inverse[2][3]; links.new(value,offset.inputs[0]); value=offset.outputs[0]
    above=nodes.new('ShaderNodeMath'); above.operation='GREATER_THAN'; above.inputs[1].default_value=height; links.new(value,above.inputs[0])
    transparent=nodes.new('ShaderNodeBsdfTransparent'); transparent.inputs[0].default_value=(1,1,1,1)
    mix=nodes.new('ShaderNodeMixShader'); links.new(above.outputs[0],mix.inputs[0]); links.new(original,mix.inputs[1]); links.new(transparent.outputs[0],mix.inputs[2]); links.new(mix.outputs[0],output.inputs['Surface'])
    return above.inputs[1]

def print_bead_profile(width, height, feature, profile='stadium-with-elliptical-fallback'):
    """Independent capsule geometry from W/H: area H*(W-H)+pi*H²/4.
    Flat top/bottom have span W-H; bridge or W<H keeps explicit ellipse.
    No source or path vertex is moved, merged or substituted.
    """
    if profile=='elliptical-bead-12-sides' or feature==7 or width<height:
        return [(width*.5*math.cos(index*math.tau/12),height*.5*math.sin(index*math.tau/12)) for index in range(12)],'legacy-ellipse' if profile=='elliptical-bead-12-sides' else 'elliptical-fallback'
    radius=height/2; offset=(width-height)/2
    points=[]
    for center,start in ((offset,-math.pi/2),(-offset,math.pi/2)):
        for step in range(7):
            angle=start+step*math.pi/6; points.append((center+radius*math.cos(angle),radius*math.sin(angle)))
    return points,'stadium'

def actual_layer_meshes(data, layer_index, materials):
    """One closed sliced bead per original segment, grouped only by tool.
    Vertices of different paths are never welded, fit, coalesced or simplified.
    This is an extrusion display profile, not a simulated melt-flow surface.
    """
    import bpy
    arrays=data['arrays']; matrix=data['matrix']; first=max(0,layer_index-data['history']+1)
    by_tool={}; count=0; roles={}; profiles={}
    reflected=matrix[0]*(matrix[5]*matrix[10]-matrix[9]*matrix[6])-matrix[4]*(matrix[1]*matrix[10]-matrix[9]*matrix[2])+matrix[8]*(matrix[1]*matrix[6]-matrix[5]*matrix[2])<0
    for index in range(arrays['layerOffsets'][first],arrays['layerOffsets'][layer_index+1]):
        segment=arrays['layerSegments'][index]; offset=segment*6
        if arrays['features'][segment] in (10,11): continue
        ax,ay,az,bx,by,bz=arrays['positions'][offset:offset+6]; dx,dy,dz=bx-ax,by-ay,bz-az; length=math.hypot(dx,dy)
        width=arrays['widths'][segment]; height=arrays['heights'][segment]; tool=arrays['tools'][segment]
        vertices,faces,smoothing=by_tool.setdefault(tool,([],[],[])); start=len(vertices)
        center=((ax+bx)/2,(ay+by)/2,(az+bz)/2-height/2); perpendicular=(dy/length,-dx/length,0)
        ring,kind=print_bead_profile(width,height,arrays['features'][segment],data['manifest']['crossSection']); ring_count=len(ring); profiles[kind]=profiles.get(kind,0)+1
        for along in (-.5,.5):
            for across,vertical in ring:
                p=(center[0]+along*dx+across*perpendicular[0],center[1]+along*dy+across*perpendicular[1],center[2]+along*dz+vertical)
                vertices.append(tuple(matrix[row]*p[0]+matrix[4+row]*p[1]+matrix[8+row]*p[2]+matrix[12+row] for row in range(3)))
        for radial in range(ring_count):
            next_radial=(radial+1)%ring_count; faces.append((start+radial,start+ring_count+radial,start+ring_count+next_radial,start+next_radial)); smoothing.append(True)
        faces.append(tuple(start+radial for radial in range(ring_count))); faces.append(tuple(start+ring_count+radial for radial in reversed(range(ring_count)))); smoothing.extend((False,False))
        count+=1; role=arrays['features'][segment]; roles[str(role)]=roles.get(str(role),0)+1
    objects=[]
    for tool,(vertices,faces,smoothing) in by_tool.items():
        if reflected: faces=[tuple(reversed(face)) for face in faces]
        mesh=bpy.data.meshes.new('Actual sliced bead geometry'); mesh.from_pydata(vertices,[],faces); mesh.materials.append(materials[tool]); mesh.update()
        for polygon in mesh.polygons: polygon.use_smooth=smoothing[polygon.index]
        object=bpy.data.objects.new('Actual walls and infill tool '+str(tool+1),mesh); bpy.context.scene.collection.objects.link(object); objects.append(object)
    return objects,count,roles,profiles

def render(config):
    import bpy
    from mathutils import Matrix,Vector,Quaternion
    paths=config['_paths']; output=config['output']; paths['output'].mkdir(parents=True,exist_ok=True)
    started=time.monotonic(); bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    scene=bpy.context.scene; scene.render.engine='CYCLES'; scene.cycles.samples=output['samples']; scene.cycles.use_denoising=True; scene.cycles.transparent_max_bounces=128
    scene.cycles.seed=5489; scene.cycles.use_animated_seed=False; scene.cycles.max_bounces=8; scene.cycles.diffuse_bounces=4
    scene.render.resolution_x=output['width']; scene.render.resolution_y=output['height']; scene.render.resolution_percentage=100
    scene.render.film_transparent=True; scene.render.dither_intensity=0; scene.render.image_settings.file_format='PNG'; scene.render.image_settings.color_mode='RGBA'
    scene.view_settings.view_transform='Standard'; scene.view_settings.look='None'; scene.view_settings.exposure=0; scene.view_settings.gamma=1
    devices=select_cycles_devices(scene,bpy.context.preferences.addons['cycles'].preferences)
    bpy.ops.import_scene.gltf(filepath=str(paths['scene']),import_pack_images=True,merge_vertices=False)
    source_objects=list(scene.objects); sources=[object for object in source_objects if object.type=='MESH']
    if not sources: raise ValueError('GLB has no mesh geometry')
    if len(sources)>4096: raise ValueError('Full scene object count exceeds HQ memory budget; no instances were dropped')
    # Blender glTF importer converts glTF Y-up to Blender Z-up. Cancel that
    # conversion once at the hierarchy root; camera and config stay Three Y-up.
    axis=bpy.data.objects.new('Three Y-up metre frame',None); scene.collection.objects.link(axis)
    axis.rotation_euler[0]=-math.pi/2
    for object in source_objects:
        if object.parent is None:
            local=object.matrix_basis.copy(); object.parent=axis; object.matrix_parent_inverse=Matrix.Identity(4); object.matrix_basis=local
        if object.type in ('LIGHT','CAMERA'): object.hide_render=True
    bpy.context.view_layer.update()
    original={object:object.data for object in sources}
    original_signatures={mesh:geometry_signature(mesh) for mesh in set(original.values())}
    triangles=sum(len(mesh.loop_triangles) if mesh.loop_triangles else (mesh.calc_loop_triangles() or len(mesh.loop_triangles)) for mesh in original.values())
    if triangles>MAX_TRIANGLES: raise ValueError('Full mesh exceeds HQ memory budget; source was not simplified')
    expected=config.get('stats',{}).get('expectedTriangles',config.get('sourceTriangles',config.get('capabilities',{}).get('triangles')))
    if expected is not None and triangles!=expected: raise ValueError('Imported GLB triangle count differs from source')
    print_data=config.get('_print'); print_inverse=None
    if print_data:
        matrix=print_data['matrix']; print_inverse=Matrix([[matrix[column*4+row] for column in range(4)] for row in range(4)]).inverted()
    materials=set(material for object in sources for material in object.data.materials if material)
    for material in materials: add_fdm(material,config.get('surface',{}))
    source_clips=[source_height_clip(material,100000000 if print_data else config['bounds']['maxY']+.001,print_inverse) for material in materials]
    world_points=[object.matrix_world@Vector(corner) for object in sources for corner in object.bound_box]
    object_y={object:(min((object.matrix_world@Vector(corner)).y for corner in object.bound_box),max((object.matrix_world@Vector(corner)).y for corner in object.bound_box)) for object in sources}
    object_bounds={object:(Vector(tuple(min((object.matrix_world@Vector(corner))[index] for corner in object.bound_box) for index in range(3))),Vector(tuple(max((object.matrix_world@Vector(corner))[index] for corner in object.bound_box) for index in range(3)))) for object in sources}
    minimum=Vector(tuple(min(point[index] for point in world_points) for index in range(3)))
    maximum=Vector(tuple(max(point[index] for point in world_points) for index in range(3)))
    camera_data=bpy.data.cameras.new('Calibrated source camera'); camera=bpy.data.objects.new(camera_data.name,camera_data); scene.collection.objects.link(camera); scene.camera=camera
    camera.location=config['camera']['position']; q=config['camera']['quaternion']; camera.rotation_mode='QUATERNION'; camera.rotation_quaternion=Quaternion((q[3],q[0],q[1],q[2])).normalized()
    camera_data.sensor_fit='VERTICAL'; camera_data.sensor_height=config['camera'].get('effectiveSensorHeightMm',24)
    projection=config['camera'].get('projectionMatrix'); aspect=output['width']/output['height']
    camera_data.lens=config['camera'].get('physicalFocalLengthMm',camera_data.sensor_height*projection[5]/2 if projection else camera_data.sensor_height/(2*math.tan(math.radians(config['camera']['fov'])/2)))
    if projection: camera_data.shift_x=projection[8]*aspect/2; camera_data.shift_y=projection[9]/2
    camera_data.clip_start=max(.00001,config['camera'].get('near',.001)); camera_data.clip_end=max(camera_data.clip_start+1,config['camera'].get('far',100))
    bpy.context.view_layer.update()
    actual=camera.calc_matrix_camera(bpy.context.evaluated_depsgraph_get(),x=output['width'],y=output['height'])
    projection_error=max(abs(actual[row][column]-projection[column*4+row]) for row,column in ((0,0),(1,1),(0,2),(1,2))) if projection else 0
    if projection_error>1e-4: raise ValueError('Blender crop projection does not match the source camera: '+str(projection_error))
    dof=config.get('dof',{}); camera_data.dof.use_dof=bool(dof.get('enabled',dof.get('dofEnabled',False)))
    if camera_data.dof.use_dof:
        direction=camera.rotation_quaternion@Vector((0,0,-1)); depths=[(point-camera.location).dot(direction) for point in world_points]
        focus=setting(dof,'focus',dof.get('dofFocus',50),0,100)/100
        distance=min(depths)+(max(depths)-min(depths))*focus
        camera_data.dof.focus_distance=setting(dof,'focusDistanceM',dof.get('focusDistance',distance),.001,100)
        camera_data.dof.aperture_fstop=setting(dof,'fStop',18/(1+2*setting(dof,'strength',dof.get('dofStrength',10),0,100)/100),.7,64)
    lighting=config.get('lighting',{}); world=bpy.data.worlds.new('Approximate cabin environment'); world.use_nodes=True
    wn,wl=world.node_tree.nodes,world.node_tree.links; wn.clear()
    geometry=wn.new('ShaderNodeNewGeometry'); split=wn.new('ShaderNodeSeparateXYZ'); wl.new(geometry.outputs['Incoming'],split.inputs[0])
    # Cycles background Geometry.Incoming is -ray.D. Three-Y-up sky rays have
    # Incoming.Y < 0; invert it so upper environment uses sky, lower uses ground.
    gain=wn.new('ShaderNodeMath'); gain.operation='MULTIPLY_ADD'; gain.inputs[1].default_value=-.5; gain.inputs[2].default_value=.5; wl.new(split.outputs['Y'],gain.inputs[0])
    mix=wn.new('ShaderNodeMixRGB'); mix.blend_type='MIX'; mix.inputs[1].default_value=(*hex_linear(lighting.get('ambientGroundColor'),'#747a83'),1); mix.inputs[2].default_value=(*hex_linear(lighting.get('ambientSkyColor'),'#d6dfe9'),1); wl.new(gain.outputs[0],mix.inputs[0])
    bg=wn.new('ShaderNodeBackground'); bg.inputs['Strength'].default_value=.14*setting(lighting,'ambientIntensity',.72,0,8); wl.new(mix.outputs[0],bg.inputs[0])
    wo=wn.new('ShaderNodeOutputWorld'); wl.new(bg.outputs[0],wo.inputs[0]); scene.world=world
    target=(minimum+maximum)*.5
    extent=max((maximum-minimum).length,.25)
    az=math.radians(setting(lighting,'lightAzimuth',-30,-180,180)); el=math.radians(setting(lighting,'lightElevation',66,10,85)); distance=max(.45,extent*2)
    key_position=target+Vector((math.sin(az)*math.cos(el),math.sin(el),math.cos(az)*math.cos(el)))*distance
    def area(name,position,energy,size,color):
        data=bpy.data.lights.new(name,'AREA'); data.energy=energy; data.color=color; data.shape='DISK'; data.size=size
        object=bpy.data.objects.new(name,data); scene.collection.objects.link(object); object.location=position; object.rotation_euler=(target-object.location).to_track_quat('-Z','Y').to_euler()
    softness=setting(lighting,'shadowRadius',7,1,8)
    area('Approximate soft key',key_position,.6*setting(lighting,'keyIntensity',1.55,0,8)*(distance/.45)**2,.015+.035*softness,kelvin_rgb(setting(lighting,'colorTemperature',7400,2000,12000)))
    # The scene package converts actual source fill positions to metres.
    fill_position=Vector(vector(lighting['fillPosition'],'fillPosition')) if 'fillPosition' in lighting else target+Vector((.3,.2,-.3))
    area('Approximate reflected fill',fill_position,.625*setting(lighting,'fillIntensity',.24,0,8)*(max(.05,(fill_position-target).length)/.4)**2,.3,hex_linear(lighting.get('fillColor'),'#d1dfed'))
    plane=config['plane']; w,d,y=plane['widthM']/2,plane['depthM']/2,plane.get('yM',0)
    mesh=bpy.data.meshes.new('Photo receiver'); mesh.from_pydata([(-w,y,-d),(w,y,-d),(w,y,d),(-w,y,d)],[],[(0,3,2,1)])
    shadow_collection=bpy.data.collections.new('HQ shadow receiver'); scene.collection.children.link(shadow_collection)
    bounce_collection=bpy.data.collections.new('HQ model bounce receiver'); scene.collection.children.link(bounce_collection)
    receiver=bpy.data.objects.new('Physical soft shadow catcher',mesh); shadow_collection.objects.link(receiver); receiver.is_shadow_catcher=True
    ground=bpy.data.materials.new('Approximate PEI bounce'); ground.use_nodes=True; ground.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(.22,.23,.24,1); ground.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.9; mesh.materials.append(ground)
    bounce=receiver.copy(); bounce.data=mesh; bounce.is_shadow_catcher=False; bounce.visible_camera=False; bounce_collection.objects.link(bounce)
    background=config.get('background',{}); has_backdrop=not bool(background.get('transparent',False))
    shadow_enabled=bool(plane.get('shadowEnabled',True)) and has_backdrop
    receiver.hide_render=not shadow_enabled
    model_layer=scene.view_layers[0]; model_layer.name='HQ Model'; model_layer.layer_collection.children[shadow_collection.name].exclude=True
    shadow_layer=scene.view_layers.new('HQ Shadow'); shadow_layer.layer_collection.children[bounce_collection.name].exclude=True; shadow_layer.cycles.use_pass_shadow_catcher=True; shadow_layer.use=shadow_enabled
    if hasattr(scene, 'compositing_node_group'):
        tree=bpy.data.node_groups.new('Growth compositor', 'CompositorNodeTree')
        tree.interface.new_socket(name='Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        scene.compositing_node_group=tree
        output_node='NodeGroupOutput'
    else:
        scene.use_nodes=True; tree=scene.node_tree; output_node='CompositorNodeComposite'
    nodes,links=tree.nodes,tree.links; nodes.clear(); layers=nodes.new('CompositorNodeRLayers'); layers.layer=model_layer.name
    grade=config.get('grading',{}); rendered=build_model_grade(scene,layers.outputs['Image'],grade,setting(grade,'exposure',lighting.get('exposure',1),.25,2.5))
    backdrop=None
    if paths['photo'] and has_backdrop:
        photo=nodes.new('CompositorNodeImage'); photo.image=bpy.data.images.load(str(paths['photo'])); photo.image.colorspace_settings.name='sRGB'
        scale=nodes.new('CompositorNodeScale')
        if hasattr(scale,'space'): scale.space='RENDER_SIZE'
        else: scale.inputs['Type'].default_value='Render Size'
        links.new(photo.outputs['Image'],scale.inputs[0])
        backdrop=scale.outputs[0]
    elif has_backdrop:
        solid=nodes.new(compositor_node_type(scene,'CompositorNodeRGB')); solid.outputs[0].default_value=(*hex_linear(background.get('color'),'#30333a'),1); backdrop=solid.outputs[0]
    shadow_mix=None
    if backdrop is not None:
        if shadow_enabled:
            shadow=nodes.new('CompositorNodeRLayers'); shadow.layer=shadow_layer.name
            intensity=nodes.new(compositor_node_type(scene,'CompositorNodeMixRGB')); shadow_mix=intensity; intensity.blend_type='MIX'; intensity.inputs[0].default_value=setting(lighting,'shadowOpacity',.28,0,.7); intensity.inputs[1].default_value=(1,1,1,1); links.new(shadow.outputs['Shadow Catcher'],intensity.inputs[2])
            multiply=nodes.new(compositor_node_type(scene,'CompositorNodeMixRGB')); multiply.blend_type='MULTIPLY'; multiply.inputs[0].default_value=1; links.new(backdrop,multiply.inputs[1]); links.new(intensity.outputs[0],multiply.inputs[2]); backdrop=multiply.outputs[0]
        over=nodes.new('CompositorNodeAlphaOver')
        if hasattr(scene,'compositing_node_group'):
            over.inputs['Factor'].default_value=1; links.new(backdrop,over.inputs['Background']); links.new(rendered,over.inputs['Foreground'])
        else:
            over.inputs[0].default_value=1; links.new(backdrop,over.inputs[1]); links.new(rendered,over.inputs[2])
        rendered=over.outputs[0]
    composite=nodes.new(output_node); links.new(rendered,composite.inputs[0])
    # Source surfaces remain untouched. Real slice beads supply the exposed
    # walls/infill; a missing slice stays open, never a fake full-solid cap.
    print_materials={}
    if print_data:
        for tool,color in print_data['colors'].items():
            material=bpy.data.materials.new('Actual sliced filament '+str(tool+1)); material.use_nodes=True
            bsdf=material.node_tree.nodes['Principled BSDF']; bsdf.inputs['Base Color'].default_value=(*hex_linear(color,'#ffffff'),1)
            bsdf.inputs['Metallic'].default_value=0
            bsdf.inputs['Roughness'].default_value={'pla':.64,'matte':.88,'silk':.30,'petg':.38}.get(config.get('surface',{}).get('preset','auto'),.64)
            print_materials[tool]=material
    emit({'type':'ready','triangles':triangles,'materials':len(materials),'devices':devices,'capMode':'sliced-gcode' if print_data else 'slice-required-open-section','projectionError':projection_error})
    source_preservation_checks=0; previous_growth=None; previous_frame=None; actual_rendered_frames=0
    print_objects=[]; previous_layer=None; print_window_peak=0; print_roles={}; print_profiles={}; print_windows=[]
    for index in range(output['frames']):
        growth=growth_at_frame(index,output); raw_growth=growth; layer_index=None
        if print_data:
            layer_index=print_data['layers']-1 if growth==1 else min(print_data['layers'],math.floor(growth*print_data['layers']+1e-10))-1
            state_empty=layer_index<0; state_complete=growth==1
            height=print_data['arrays']['layerHeights'][layer_index] if layer_index>=0 else 0
            state_key=(layer_index,state_complete)
        else:
            if config.get('growth',{}).get('stepped') and 0<growth<1:
                layers=int(setting(config['growth'],'layerCount',180,1,10000)); growth=math.floor(growth*layers)/layers
            state_empty=growth<=0; state_complete=growth==1
            height=config['bounds']['minY']+(config['bounds']['maxY']-config['bounds']['minY'])*growth; state_key=growth
        filename='frames'+str(index).zfill(6)+'.png'; destination=paths['output']/filename
        if previous_growth==state_key and previous_frame:
            if any(object.data is not original[object] for object in sources): raise RuntimeError('Visible source mesh data was substituted')
            source_preservation_checks+=1; shutil.copyfile(previous_frame,destination)
            emit({'type':'progress','frame':index,'frames':output['frames'],'growth':growth,'rawGrowth':raw_growth,'path':filename,'cached':True,'layerIndex':layer_index})
            continue
        for clip in source_clips: clip.default_value=height+(.00001 if print_data else 1e-8) if not state_complete else 100000000
        for object in sources:
            object.hide_render=state_empty
            if object.data is not original[object]: raise RuntimeError('Visible source mesh data was substituted')
        visible_print_segments=0
        if print_data:
            for object in print_objects:
                mesh=object.data; bpy.data.objects.remove(object,do_unlink=True); bpy.data.meshes.remove(mesh)
            print_objects=[]
            if not state_empty and not state_complete:
                print_objects,visible_print_segments,roles,profiles=actual_layer_meshes(print_data,layer_index,print_materials)
                print_window_peak=max(print_window_peak,visible_print_segments)
                for key,value in roles.items(): print_roles[key]=max(print_roles.get(key,0),value)
                for key,value in profiles.items(): print_profiles[key]=max(print_profiles.get(key,0),value)
            print_windows.append({'frame':index,'layerIndex':layer_index,'heightMm':height,'segments':visible_print_segments})
        source_preservation_checks+=1
        receiver.hide_render=not shadow_enabled or state_empty; bounce.hide_render=state_empty
        if shadow_mix: shadow_mix.inputs[0].default_value=0 if state_empty else setting(lighting,'shadowOpacity',.28,0,.7)
        scene.frame_set(index+1)
        scene.render.filepath=str(destination)
        bpy.ops.render.render(write_still=True)
        actual_rendered_frames+=1; previous_growth=state_key; previous_frame=destination
        emit({'type':'progress','frame':index,'frames':output['frames'],'growth':growth,'rawGrowth':raw_growth,'path':filename,'layerIndex':layer_index,'printSegments':visible_print_segments})
    final_triangles=0
    for object in sources:
        if object.data is not original[object]: raise RuntimeError('Source mesh data was replaced')
        object.data.calc_loop_triangles(); final_triangles+=len(object.data.loop_triangles)
    if final_triangles!=triangles: raise RuntimeError('Complete mesh triangle count changed')
    if any(geometry_signature(mesh)!=signature for mesh,signature in original_signatures.items()): raise RuntimeError('Source positions, normals, palette regions or topology changed')
    stats={'schemaVersion':1,'blender':bpy.app.version_string,'originalTriangles':triangles,'completeTriangles':final_triangles,'sourceGeometryUnchanged':True,'sourcePreservationFrames':source_preservation_checks,'sourceMeshes':len(sources),'materials':len(materials),'decimation':False,'frames':output['frames'],'actualRenderedFrames':actual_rendered_frames,'growthFrames':output['growthFrames'],'durationSeconds':output.get('durationSeconds'),'growthSeconds':output.get('growthSeconds'),'width':output['width'],'height':output['height'],'samples':output['samples'],'devices':devices,'seconds':round(time.monotonic()-started,3),'projectionError':projection_error,'capMode':'sliced-gcode' if print_data else 'slice-required-open-section','capOnlyTrianglesPeak':0,'printSegments':print_data['count'] if print_data else 0,'printLayerCount':print_data['layers'] if print_data else 0,'printWindowSegmentsPeak':print_window_peak,'printWindows':print_windows,'printRoleCountsPeak':print_roles,'printCrossSection':print_data['manifest']['crossSection'] if print_data else None,'printProfileCountsPeak':print_profiles,'cutTopology':'original-full-surfaces-plus-real-slice-beads' if print_data else 'original-full-surfaces-open-until-sliced','transparentBounces':128,'environmentMode':'artistic-area-light-proxy','shadowMode':'independent-rgb-catcher-times-linear-background','photoProtected':bool(paths['photo']),'gradingScope':'model-only'}
    write_completion_stats(paths['output'],stats,output)

def main():
    args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
    if len(args)!=1: raise ValueError('Expected exactly one config path after --')
    render(validate_config(args[0]))

if __name__=='__main__':
    try: main()
    except Exception as error:
        emit({'type':'error','error':str(error)}); traceback.print_exc(file=sys.stderr); sys.exit(1)

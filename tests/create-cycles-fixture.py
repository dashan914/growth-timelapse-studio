import bpy, pathlib
base=pathlib.Path(__file__).resolve().parent/'fixtures/cycles'
base.mkdir(exist_ok=True)
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
for color,x in [((.5,.06,.04,1),-.045),((.03,.14,.55,1),.045)]:
    bpy.ops.mesh.primitive_cube_add(size=1,location=(x,0,.05))
    object=bpy.context.object; object.scale=(.07,.07,.10)
    material=bpy.data.materials.new('Source red' if x<0 else 'Source blue'); material.use_nodes=True
    material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=color
    material.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.64
    object.data.materials.append(material)
bpy.ops.export_scene.gltf(filepath=str(base/'scene.glb'),export_format='GLB',export_yup=True,export_normals=True,export_materials='EXPORT')

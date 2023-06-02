const vertexShader = `
uniform mat4 textureMatrix;

varying vec2 vUv;
varying vec4 vMirrorCoord;
varying vec3 vWorldPosition;

// https://tympanus.net/codrops/2019/10/29/real-time-multiside-refraction-in-three-steps/
vec4 getWorldPosition(mat4 modelMat,vec3 pos){
    vec4 worldPosition=modelMat*vec4(pos,1.);
    return worldPosition;
}

void main(){
    vec3 p=position;
    
    gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
    
    vUv=uv;
    vMirrorCoord=textureMatrix*vec4(p,1.);
    vWorldPosition=getWorldPosition(modelMatrix,p).xyz;
}
`;

const fragmentShader = `
// https://stackoverflow.com/questions/13501081/efficient-bicubic-filtering-code-in-glsl
vec4 sampleBicubic(float v){
    vec4 n=vec4(1.,2.,3.,4.)-v;
    vec4 s=n*n*n;
    vec4 o;
    o.x=s.x;
    o.y=s.y-4.*s.x;
    o.z=s.z-4.*s.y+6.*s.x;
    o.w=6.-o.x-o.y-o.z;
    return o;
}

vec4 sampleBicubic(sampler2D tex,vec2 st,vec2 texResolution){
    vec2 pixel=1./texResolution;
    st=st*texResolution-.5;
    
    vec2 fxy=fract(st);
    st-=fxy;
    
    vec4 xcubic=sampleBicubic(fxy.x);
    vec4 ycubic=sampleBicubic(fxy.y);
    
    vec4 c=st.xxyy+vec2(-.5,1.5).xyxy;
    
    vec4 s=vec4(xcubic.xz+xcubic.yw,ycubic.xz+ycubic.yw);
    vec4 offset=c+vec4(xcubic.yw,ycubic.yw)/s;
    
    offset*=pixel.xxyy;
    
    vec4 sample0=texture(tex,offset.xz);
    vec4 sample1=texture(tex,offset.yz);
    vec4 sample2=texture(tex,offset.xw);
    vec4 sample3=texture(tex,offset.yw);
    
    float sx=s.x/(s.x+s.y);
    float sy=s.z/(s.z+s.w);
    
    return mix(mix(sample3,sample2,sx),mix(sample1,sample0,sx),sy);
}

// With original size argument
vec4 packedTexture2DLOD(sampler2D tex,vec2 uv,int level,vec2 originalPixelSize){
    float floatLevel=float(level);
    vec2 atlasSize;
    atlasSize.x=floor(originalPixelSize.x*1.5);
    atlasSize.y=originalPixelSize.y;
    // we stop making mip maps when one dimension == 1
    float maxLevel=min(floor(log2(originalPixelSize.x)),floor(log2(originalPixelSize.y)));
    floatLevel=min(floatLevel,maxLevel);
    // use inverse pow of 2 to simulate right bit shift operator
    vec2 currentPixelDimensions=floor(originalPixelSize/pow(2.,floatLevel));
    vec2 pixelOffset=vec2(
        floatLevel>0.?originalPixelSize.x:0.,
        floatLevel>0.?currentPixelDimensions.y:0.
    );
    // "minPixel / atlasSize" samples the top left piece of the first pixel
    // "maxPixel / atlasSize" samples the bottom right piece of the last pixel
    vec2 minPixel=pixelOffset;
    vec2 maxPixel=pixelOffset+currentPixelDimensions;
    vec2 samplePoint=mix(minPixel,maxPixel,uv);
    samplePoint/=atlasSize;
    vec2 halfPixelSize=1./(2.*atlasSize);
    samplePoint=min(samplePoint,maxPixel/atlasSize-halfPixelSize);
    samplePoint=max(samplePoint,minPixel/atlasSize+halfPixelSize);
    return sampleBicubic(tex,samplePoint,originalPixelSize);
}

vec4 packedTexture2DLOD(sampler2D tex,vec2 uv,float level,vec2 originalPixelSize){
    float ratio=mod(level,1.);
    int minLevel=int(floor(level));
    int maxLevel=int(ceil(level));
    vec4 minValue=packedTexture2DLOD(tex,uv,minLevel,originalPixelSize);
    vec4 maxValue=packedTexture2DLOD(tex,uv,maxLevel,originalPixelSize);
    return mix(minValue,maxValue,ratio);
}

// https://www.shadertoy.com/view/4djSRW
float hash12(vec2 p){
    vec3 p3=fract(vec3(p.xyx)*.1031);
    p3+=dot(p3,p3.yzx+19.19);
    return fract((p3.x+p3.y)*p3.z);
}

vec2 hash22(vec2 p){
    vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));
    p3+=dot(p3,p3.yzx+19.19);
    return fract((p3.xx+p3.yz)*p3.zy);
}

// https://gist.github.com/companje/29408948f1e8be54dd5733a74ca49bb9
float map(float value,float min1,float max1,float min2,float max2){
    return min2+(value-min1)*(max2-min2)/(max1-min1);
}

uniform vec3 color;
uniform sampler2D tDiffuse;
varying vec2 vUv;
varying vec4 vMirrorCoord;
varying vec3 vWorldPosition;

uniform sampler2D uRoughnessTexture;
uniform sampler2D uNormalTexture;
uniform sampler2D uOpacityTexture;
uniform vec2 uTexScale;
uniform vec2 uTexOffset;
uniform float uDistortionAmount;
uniform float uBlurStrength;
uniform float iTime;
uniform float uRainCount;
uniform vec2 uMipmapTextureSize;

#define MAX_RADIUS 1
#define DOUBLE_HASH 0

void main(){
    vec2 p=vUv;
    vec2 texUv=p*uTexScale;
    texUv+=uTexOffset;
    float floorOpacity=texture(uOpacityTexture,texUv).r;
    vec3 floorNormal=texture(uNormalTexture,texUv).rgb*2.-1.;
    floorNormal=normalize(floorNormal);
    float roughness=texture(uRoughnessTexture,texUv).r;
    
    vec2 reflectionUv=vMirrorCoord.xy/vMirrorCoord.w;
    
    // https://www.shadertoy.com/view/ldfyzl
    vec2 rippleUv=75.*p*uTexScale;
    
    vec2 p0=floor(rippleUv);
    
    float rainStrength=map(uRainCount,0.,10000.,3.,.5);
    if(rainStrength==3.){
        rainStrength=50.;
    }
    
    vec2 circles=vec2(0.);
    for(int j=-MAX_RADIUS;j<=MAX_RADIUS;++j)
    {
        for(int i=-MAX_RADIUS;i<=MAX_RADIUS;++i)
        {
            vec2 pi=p0+vec2(i,j);
            #if DOUBLE_HASH
            vec2 hsh=hash22(pi);
            #else
            vec2 hsh=pi;
            #endif
            vec2 p=pi+hash22(hsh);
            
            float t=fract(.8*iTime+hash12(hsh));
            vec2 v=p-rippleUv;
            float d=length(v)-(float(MAX_RADIUS)+1.)*t+(rainStrength*.1*t);
            
            float h=1e-3;
            float d1=d-h;
            float d2=d+h;
            float p1=sin(31.*d1)*smoothstep(-.6,-.3,d1)*smoothstep(0.,-.3,d1);
            float p2=sin(31.*d2)*smoothstep(-.6,-.3,d2)*smoothstep(0.,-.3,d2);
            circles+=.5*normalize(v)*((p2-p1)/(2.*h)*(1.-t)*(1.-t));
        }
    }
    circles/=float((MAX_RADIUS*2+1)*(MAX_RADIUS*2+1));
    
    float intensity=.05*floorOpacity;
    vec3 n=vec3(circles,sqrt(1.-dot(circles,circles)));
    
    vec2 rainUv=intensity*n.xy;
    
    vec2 finalUv=reflectionUv+floorNormal.xy*uDistortionAmount-rainUv;
    
    float level=roughness*uBlurStrength;
    
    vec3 col=packedTexture2DLOD(tDiffuse,finalUv,level,uMipmapTextureSize).rgb;
    
    gl_FragColor=vec4(col,1.);
    
    // vec4 base=texture2DProj(tDiffuse,vec4(finalUv,1.,1.));
    // gl_FragColor=vec4(base.rgb,1.);
}
`;

const vertexShader2 = `
#define GLSLIFY 1
attribute float aProgress;
attribute float aSpeed;

varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vWorldPosition;
varying vec3 vPosition;
varying vec2 vScreenSpace;
varying vec3 vViewPosition;

uniform float uTime;
uniform float uSpeed;
uniform float uHeightRange;

void main()	{
    vUv = uv;

    vec3 transformed = vec3( position );

    vec3 up = vec3(modelViewMatrix[0][1], modelViewMatrix[1][1], modelViewMatrix[2][1]);
    vec3 right = vec3(modelViewMatrix[0][0], modelViewMatrix[1][0], modelViewMatrix[2][0]);
    vec3 billboardPos = right * position.x + up * position.y;

    vec4 mvPosition = vec4( billboardPos, 1.0 );

    float yPos = mod(aProgress - uTime * aSpeed * 0.25, 1.) * uHeightRange - (uHeightRange * 0.5);
    // float yPos = mod(aProgress, 1.) * 20. - 10.;

    vec4 worldPosition = vec4( transformed, 1.0 );
    #ifdef USE_INSTANCING
        worldPosition = instanceMatrix * worldPosition;
    #endif
    worldPosition.y += yPos;
    worldPosition = modelMatrix * worldPosition;
    vWorldPosition = worldPosition.xyz;

    vPosition = transformed;

    #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
    #endif

    mvPosition.y += yPos;

    vec4 earlyProjection = projectionMatrix * modelViewMatrix * mvPosition;
    vScreenSpace = earlyProjection.xy / earlyProjection.w * 0.5 + vec2(0.5);

    mvPosition = modelViewMatrix * mvPosition;
    gl_Position = projectionMatrix * mvPosition;

    vViewPosition = -mvPosition.xyz;
}
`;

const fragmentShader2 = `
#define GLSLIFY 1
varying vec3 vNormal;
varying vec2 vUv;
varying vec2 vScreenSpace;
varying vec3 vViewPosition;

uniform sampler2D uBgTexture;
uniform sampler2D uNormalTexture;
uniform float uBaseBrightness;
uniform float uRefraction;

void main() {
    vec4 normalColor = texture2D(uNormalTexture, vUv);

    if (normalColor.a < 0.5) discard;

    vec3 normal = normalize(normalColor.rgb * 2. - 1.);

    vec2 uv = vUv;
    uv = normal.xy;
    uv = vec2(vScreenSpace.x, vScreenSpace.y) + uv * uRefraction;

    vec4 bgColor = texture2D(uBgTexture, uv);

    // vec3 rainColor = vec3(0.89, 0.92, 1.);
    // gl_FragColor = vec4(rainColor, 1.);
    gl_FragColor = vec4(bgColor.rgb + uBaseBrightness * pow(normal.b, 10.), 1.);
    // gl_FragColor = vec4(normal.rgb, 1.);
}
`;

let mouseX = 0,
    mouseY = 0
    isSlowMo = false

window.addEventListener('mousemove', (event) => {
    mouseX = (event.clientX / window.innerWidth) * 2 - 1;
    mouseY = -(event.clientY / window.innerHeight) * 2 + 1;
})

window.addEventListener('mousedown', () => {
  isSlowMo = true
})

window.addEventListener('mouseup', () => {
  isSlowMo = false
})

class RainFloor extends kokomi.Component {
  constructor(base, config = {}) {
    super(base);

    const { count = 1000 } = config;

    const am = this.base.am;

    // floor
    const fNormalTex = am.items["floor-normal"];
    const fOpacityTex = am.items["floor-opacity"];
    const fRoughnessTex = am.items["floor-roughness"];
    fNormalTex.wrapS = fNormalTex.wrapT = THREE.MirroredRepeatWrapping;
    fOpacityTex.wrapS = fOpacityTex.wrapT = THREE.MirroredRepeatWrapping;
    fRoughnessTex.wrapS = fRoughnessTex.wrapT = THREE.MirroredRepeatWrapping;

    // custom reflector
    const uj = new kokomi.UniformInjector(this.base);
    this.uj = uj;
    const mirror = new kokomi.Reflector(new THREE.PlaneGeometry(25, 100));
    this.mirror = mirror;
    mirror.position.z = -25;
    mirror.rotation.x = -Math.PI / 2;

    mirror.material.uniforms = {
      ...mirror.material.uniforms,
      ...uj.shadertoyUniforms,
      ...{
        uNormalTexture: {
          value: fNormalTex,
        },
        uOpacityTexture: {
          value: fOpacityTex,
        },
        uRoughnessTexture: {
          value: fRoughnessTex,
        },
        uRainCount: {
          value: count,
        },
        uTexScale: {
          value: new THREE.Vector2(1, 4),
        },
        uTexOffset: {
          value: new THREE.Vector2(1, -0.5),
        },
        uDistortionAmount: {
          value: 0.25,
        },
        uBlurStrength: {
          value: 8,
        },
        uMipmapTextureSize: {
          value: new THREE.Vector2(window.innerWidth, window.innerHeight),
        },
      },
    };
    mirror.material.vertexShader = vertexShader;
    mirror.material.fragmentShader = fragmentShader;

    const mipmapper = new kokomi.PackedMipMapGenerator();
    this.mipmapper = mipmapper;
    const mirrorFBO = mirror.getRenderTarget();
    this.mirrorFBO = mirrorFBO;
    const mipmapFBO = new kokomi.FBO(this.base);
    this.mipmapFBO = mipmapFBO;

    mirror.material.uniforms.tDiffuse.value = mipmapFBO.rt.texture;
  }
  addExisting() {
    this.base.scene.add(this.mirror);
  }
  update() {
    this.uj.injectShadertoyUniforms(this.mirror.material.uniforms);

    this.mipmapper.update(
        this.mirrorFBO.texture,
        this.mipmapFBO.rt,
        this.base.renderer
    );
  }
}

class Rain extends kokomi.Component {
  constructor(base, config = {}) {
    super(base);

    const { count = 1000, speed = 1.5, debug = false } = config;

    const am = this.base.am;

    // rain
    const rNormalTex = am.items["rain-normal"];
    rNormalTex.flipY = false;

    const uj = new kokomi.UniformInjector(this.base);
    this.uj = uj;
    const rainMat = new THREE.ShaderMaterial({
      vertexShader: vertexShader2,
      fragmentShader: fragmentShader2,
      uniforms: {
        ...uj.shadertoyUniforms,
        ...{
          // uSpeed: {
          //   value: speed,
          // },
          uHeightRange: {
            value: 20,
          },
          uNormalTexture: {
            value: rNormalTex,
          },
          uBgTexture: {
            value: null,
          },
          uBgRt: {
            value: null,
          },
          uRefraction: {
            value: 0.05,
          },
          uBaseBrightness: {
            value: 0.07,
          },
          uTime: {
            value: 0
          }
        },
      },
    });
    this.rainMat = rainMat;

    const rain = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(),
      rainMat,
      count
    );
    this.rain = rain;
    rain.instanceMatrix.needsUpdate = true;

    const dummy = new THREE.Object3D();

    const progressArr = [];
    const speedArr = [];

    for (let i = 0; i < rain.count; i++) {
      dummy.position.set(
        THREE.MathUtils.randFloat(-10, 10),
        0,
        THREE.MathUtils.randFloat(-20, 10)
      );
      dummy.scale.set(0.03, THREE.MathUtils.randFloat(0.3, 0.5), 0.03);
      if (debug) {
        dummy.scale.setScalar(1);
        rainMat.uniforms.uSpeed.value = 0;
      }
      dummy.updateMatrix();
      rain.setMatrixAt(i, dummy.matrix);

      progressArr.push(Math.random());
      speedArr.push(dummy.scale.y * 10);
    }
    rain.rotation.set(-0.1, 0, 0.1);
    rain.position.set(0, 9, 9);

    rain.geometry.setAttribute(
      "aProgress",
      new THREE.InstancedBufferAttribute(new Float32Array(progressArr), 1)
    );
    rain.geometry.setAttribute(
      "aSpeed",
      new THREE.InstancedBufferAttribute(new Float32Array(speedArr), 1)
    );

    const bgFBO = new kokomi.FBO(this.base, {
      width: window.innerWidth * 0.1,
      height: window.innerHeight * 0.1,
    });
    this.bgFBO = bgFBO;
    rainMat.uniforms.uBgTexture.value = bgFBO.rt.texture;

    const fboCamera = this.base.camera.clone();
    this.fboCamera = fboCamera;
  }
  addExisting() {
    this.base.scene.add(this.rain);
  }
  update() {
    this.uj.injectShadertoyUniforms(this.rainMat.uniforms);

    this.rain.visible = false;
    this.base.renderer.setRenderTarget(this.bgFBO.rt);
    this.base.renderer.render(this.base.scene, this.fboCamera);
    this.base.renderer.setRenderTarget(null);
    this.rain.visible = true;
  }
}

class Sketch extends kokomi.Base {
    create() {
        this.camera.position.set(0, 2, 9);

        const lookAt = new THREE.Vector3(0, 2, 0);
        this.camera.lookAt(lookAt);

        const controls = new kokomi.OrbitControls(this);
        controls.controls.target = lookAt;
        controls.controls.enabled = false

        // config
        const config = {
            text: "love",
            color: "#ef77eb",
            rainCount: 1000,
            rainSpeed: 1.5,
            debug: false,
            soundRate: 1,
            cameraZOffset: 10
        };

        const am = new kokomi.AssetManager(this, [
            // brick
            {
                name: "brick-normal",
                type: "texture",
                path: "/assets/textures/brick-normal2.jpg",
            },
            // floor
            {
                name: "floor-normal",
                type: "texture",
                path: "/assets/textures/asphalt-pbr01/normal.png",
            },
            {
                name: "floor-opacity",
                type: "texture",
                path: "/assets/textures/asphalt-pbr01/opacity.jpg",
            },
            {
                name: "floor-roughness",
                type: "texture",
                path: "/assets/textures/asphalt-pbr01/roughness.jpg",
            },
            // rain
            {
                name: "rain-normal",
                type: "texture",
                path: "/assets/textures/rain-normal.png",
            },
            // shutter
            {
                name: "shutter-diffuse",
                type: "texture",
                path: "/assets/textures/door/shutter-Diffuse.png",
            },
            {
                name: "shutter-glossiness",
                type: "texture",
                path: "/assets/textures/door/shutter-Glossiness.png",
            },
            {
                name: "shutter-normal",
                type: "texture",
                path: "/assets/textures/door/shutter-Normal.png",
            },
            // top-cover
            {
                name: "top-cover-diffuse",
                type: "texture",
                path: "/assets/textures/door/top-cover-Diffuse.png",
            },
            // side-cover
            {
                name: "side-cover-diffuse",
                type: "texture",
                path: "/assets/textures/door/side-cover-Diffuse.png",
            },
        ]);

        this.am = am;

        am.on("ready", async () => {
            document.querySelector(".loader-screen").classList.add("hollow");

            const sound = new Howl({
                src: ['/assets/sound/rain.mp3'],
                loop: true,
                autoplay: true,
                rate: config.soundRate
            })

            // const soundRain = new Audio('/assets/sound/rain.mp3')
            // soundRain.rate
            // soundRain.play()

            // lights
            const pointLight1 = new THREE.PointLight("#81C8F2", 0.1, 17, 0.8);
            pointLight1.position.set(0, 2.3, 0);
            this.scene.add(pointLight1);

            const pointLight3 = new THREE.PointLight("#81C8F2", 1, 17, 0.8);
            pointLight3.position.set(0, 14.3, 0);
            this.scene.add(pointLight3);

            const pointLight2 = new THREE.PointLight("#81C8F2", 4, 30);
            pointLight2.position.set(0, 30, 0);
            this.scene.add(pointLight2);

            const rectLight1 = new THREE.RectAreaLight("#81C8F2", 66, 19.1, 0.2);
            rectLight1.position.set(0, 8.066, -9.8);
            rectLight1.rotation.set(
                THREE.MathUtils.degToRad(90),
                THREE.MathUtils.degToRad(180),
                0
            );
            this.scene.add(rectLight1);

            const rectLight1Helper = new kokomi.RectAreaLightHelper(rectLight1);
            this.scene.add(rectLight1Helper);

            console.log(rectLight1)

            // const rectLight2 = new THREE.RectAreaLight("#4A7895", 66, 19.1, 0.2);
            // rectLight2.position.set(0, 7.9, -10.2);
            // rectLight2.rotation.set(
            //     0,
            //     THREE.MathUtils.degToRad(180),
            //     0
            // );
            // this.scene.add(rectLight2);

            // const rectLight1Helper2 = new kokomi.RectAreaLightHelper(rectLight2);
            // this.scene.add(rectLight1Helper2);

            const geometry = new THREE.BoxGeometry( 19, 0.22, 0.0025 );
            const material = new THREE.MeshPhysicalMaterial({
              color: "#32596F",
              opacity: 0.4,
              transparent: true,
              emissive: "#32596F",
              emissiveIntensity: 1.4,
              reflectivity: 0.8,
              clearcoat: 1,
              clearcoatRoughness: 0,
              roughness: 0.5,
              metalness: 0.3,
              specularIntensity: 1,
            });
            const lampReflector = new THREE.Mesh( geometry, material );
            lampReflector.position.set(0, 7.8, -10.23);
            this.scene.add( lampReflector );

            // const rectLight2 = new THREE.RectAreaLight("#4A7895", 0.6, 19.1, 0.2);
            // rectLight2.position.set(0, 7.9, -10.23);
            // rectLight2.rotation.set(
            //     0,
            //     THREE.MathUtils.degToRad(180),
            //     0
            // );
            // this.scene.add(rectLight2);

            // console.log(rectLight2)

            // const rectLight1Helper2 = new kokomi.RectAreaLightHelper(rectLight2);
            // this.scene.add(rectLight1Helper2);

            // brick
            const brickTex = am.items["brick-normal"];
            brickTex.rotation = THREE.MathUtils.degToRad(90);
            brickTex.wrapS = brickTex.wrapT = THREE.RepeatWrapping;
            brickTex.repeat.set(5, 8);

            // shutter
            const shutterDiffuseTex = am.items["shutter-diffuse"];
            shutterDiffuseTex.flipY = !1

            const shutterGlossinessTex = am.items["shutter-glossiness"];
            shutterGlossinessTex.flipY = !1

            const shutterNormalTex = am.items["shutter-normal"];
            shutterNormalTex.flipY = !1

            // top-cover
            const topCoverTex = am.items["top-cover-diffuse"];
            topCoverTex.flipY = !1

            // side-cover
            const sideCoverTex = am.items["side-cover-diffuse"];
            sideCoverTex.flipY = !1
            // model
            const gtlfLoader = new THREE.GLTFLoader()
            const url = '/assets/models/scene.glb'
            gtlfLoader.load(url, gltf => {
                const root = gltf.scene

                const walls = root.getObjectByName('walls')
                walls.material = new THREE.MeshPhongMaterial({
                    color: new THREE.Color("#111111"),
                    normalMap: brickTex,
                    normalScale: new THREE.Vector2(0.5, 0.5),
                    shininess: 50
                })

                const shutter = root.getObjectByName('shutter')
                shutter.material = new THREE.MeshPhysicalMaterial({
                    map: shutterDiffuseTex,
                    roughnessMap: shutterGlossinessTex,
                    normalMap: shutterNormalTex,
                    reflectivity: 0.8,
                    roughness: 0.5,
                    metalness: 0.3,
                    specularIntensity: 0.5,
                })

                const topCover = root.getObjectByName('top-cover')
                topCover.material = new THREE.MeshPhysicalMaterial({
                    map: topCoverTex,
                    reflectivity: 0.7,
                    metalness: 0.2,
                    specularIntensity: 0.5
                })

                const sideCover = root.getObjectByName('side-cover')
                sideCover.material = new THREE.MeshPhysicalMaterial({
                    map: sideCoverTex,
                    reflectivity: 0.7,
                    metalness: 0.2,
                    specularIntensity: 0.5
                })

                const floor = root.getObjectByName('floor')
                root.remove(floor)

                const uNeon = root.getObjectByName('u-neon')
                root.remove(uNeon)

                const cable = root.getObjectByName('cable')
                root.remove(cable)

                const power = root.getObjectByName('power')
                root.remove(power)

                const stand = root.getObjectByName('stand')
                root.remove(stand)

                this.scene.add(root)
            })

            // rain floor
            const rainFloor = new RainFloor(this, {
                count: config.rainCount,
            });
            rainFloor.addExisting();

            // rain
            const rain = new Rain(this, {speed: config.rainSpeed, count: config.rainCount, debug: false});
            rain.addExisting();

            rainFloor.mirror.ignoreObjects.push(rain.rain);

            // flicker
            const turnOffLight = () => {
                rectLight1.color.copy(new THREE.Color("#000"));
                lampReflector.material.opacity = 0
            };

            const turnOnLight = () => {
                rectLight1.color.copy(new THREE.Color("#89D7FF"));
                lampReflector.material.opacity = 0.4
            };

            let flickerTimer = null;

            const flicker = () => {
                flickerTimer = setInterval(async () => {
                const rate = Math.random();
                if (rate < 0.5) {
                    turnOffLight();
                    await kokomi.sleep(200 * Math.random());
                    turnOnLight();
                    await kokomi.sleep(200 * Math.random());
                    turnOffLight();
                    await kokomi.sleep(200 * Math.random());
                    turnOnLight();
                }
                }, 3000);
            };

            flicker();

            // postprocessing
            const composer = new POSTPROCESSING.EffectComposer(this.renderer);
            this.composer = composer;

            composer.addPass(new POSTPROCESSING.RenderPass(this.scene, this.camera));

            // bloom
            const bloom = new POSTPROCESSING.BloomEffect({
                luminanceThreshold: 0.4,
                luminanceSmoothing: 0,
                mipmapBlur: true,
                intensity: 2,
                radius: 0.4,
            });
            composer.addPass(new POSTPROCESSING.EffectPass(this.camera, bloom));

            // antialiasing
            const fxaa = new POSTPROCESSING.FXAAEffect();
            composer.addPass(new POSTPROCESSING.EffectPass(this.camera, fxaa));

            // camera rotate
            const smoothMouse = [new THREE.Vector2(0, 0), new THREE.Vector2(0, 0)]
            const mouseMoveAngle = new THREE.Vector2(0.5, 0.08)

            const euler = new THREE.Euler( 0, 0, 0, 'XYZ' );
            const quaternion = new THREE.Quaternion();

            const clock = new THREE.Clock()

            this.update(() => {
                rain.rain.material.uniforms.uTime.value += clock.getDelta() * config.rainSpeed

                smoothMouse[0].lerp({x: mouseX, y: mouseY}, 0.03)
                smoothMouse[1].lerp({x: mouseX, y: mouseY}, 0.07)
                this.camera.position.copy(new THREE.Vector3(0, 2, 0))
                this.camera.lookAt(lookAt)

                if (!controls.controls.enabled) {
                    this.camera.translateZ(-2)
                    euler.set(
                        smoothMouse[0].y * mouseMoveAngle.y,
                        -smoothMouse[0].x * mouseMoveAngle.x,
                        0
                    )
                    quaternion.setFromEuler(euler)
                    this.camera.quaternion.multiply(quaternion)
                    euler.set(0, 0, (smoothMouse[0].x - smoothMouse[1].x) * -0.1)
                    quaternion.setFromEuler(euler)
                    this.camera.quaternion.multiply(quaternion)
                    this.camera.translateZ(config.cameraZOffset)
                    this.camera.updateMatrixWorld()
                }

                if (isSlowMo) {
                  gsap.to(config, {
                      duration: 2,
                      soundRate: 0.1,
                      cameraZOffset: 5,
                      rainSpeed: 0.02,
                      rainCount: 0,
                      ease: "none",
                      onUpdate: () => {
                        this.camera.translateZ(config.cameraZOffset)

                        if (sound.playing()) {
                            sound.rate(config.soundRate)
                        }

                        // rain.rain.material.uniforms.uSpeed.value = config.rainSpeed
                        rainFloor.mirror.material.uniforms.uRainCount.value = config.rainCount
                      }
                  })
                }
                else {

                  gsap.to(config, {
                      duration: 1,
                      soundRate: 1,
                      cameraZOffset: 10,
                      rainSpeed: 1.5,
                      rainCount: 1000,
                      onUpdate: () => {
                        this.camera.translateZ(config.cameraZOffset)

                        if (sound.playing()) {
                          sound.rate(config.soundRate)
                        }

                        rain.rain.material.uniforms.uSpeed = {value: config.rainSpeed}
                        rainFloor.mirror.material.uniforms.uRainCount = {value: config.rainCount}
                      },
                  })

                }
            })
        
        });
    }
}

const createSketch = () => {
    const sketch = new Sketch();
    sketch.create();
    return sketch;
};

createSketch();
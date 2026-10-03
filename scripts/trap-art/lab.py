import numpy as np
def srgb2lin(c): return np.where(c<=0.04045,c/12.92,((c+0.055)/1.055)**2.4)
def lin2srgb(c): return np.where(c<=0.0031308,12.92*c,1.055*np.clip(c,0,None)**(1/2.4)-0.055)
M=np.array([[0.4124,0.3576,0.1805],[0.2126,0.7152,0.0722],[0.0193,0.1192,0.9505]])
Mi=np.linalg.inv(M); W=np.array([0.95047,1.0,1.08883])
def f(t): return np.where(t>0.008856,np.cbrt(t),7.787*t+16/116)
def fi(t): return np.where(t>0.206893,t**3,(t-16/116)/7.787)
def rgb2lab(rgb):
    xyz=srgb2lin(rgb)@M.T/W; fx,fy,fz=f(xyz[...,0]),f(xyz[...,1]),f(xyz[...,2])
    return np.stack([116*fy-16,500*(fx-fy),200*(fy-fz)],-1)
def lab2rgb(lab):
    fy=(lab[...,0]+16)/116; fx=fy+lab[...,1]/500; fz=fy-lab[...,2]/200
    xyz=np.stack([fi(fx),fi(fy),fi(fz)],-1)*W
    return np.clip(lin2srgb(xyz@Mi.T),0,1)
def hex2lab(h): return rgb2lab(np.array([[int(h[i:i+2],16)/255 for i in (1,3,5)]]))[0]

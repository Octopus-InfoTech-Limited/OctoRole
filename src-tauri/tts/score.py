"""Original instrumental backing, generated deterministically at the dialogue length."""
import numpy as np
import soundfile as sf


def write_score(path, seconds, sr=24000):
    with sf.SoundFile(path, "w", sr, 1, subtype="PCM_16") as out:
        total = round(seconds*sr)
        for start in range(0,total,6*sr):
            n = min(6*sr,total-start)
            t = np.arange(n)/sr
            bass = [146.83,130.81,110.,130.81][(start//(6*sr))%4]
            block = .13*np.sin(2*np.pi*bass*t)*np.minimum(1,t/.08)*np.exp(-t/2.4)
            for j,ratio in enumerate([2.,2.3784,2.9966,2.6697]):
                u=np.maximum(0,t-(.25+1.4*j))
                block += .10*np.sin(2*np.pi*bass*ratio*u)*np.minimum(1,u/.025)*np.exp(-u/.85)
            out.write(block*np.minimum(1,(n-np.arange(n))/(.11*sr)))

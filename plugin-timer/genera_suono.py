#!/usr/bin/env python3
"""Genera res/raw/allarme_recupero.wav con la stessa ricetta di sintetizzaAllarme() nell'app.
Preavviso: rintocchi a 0, 1, 2 s; arpeggio a 3 s (= scadenza) e ripetizione a 4,1 s."""
import math, struct, wave, os
PARZIALI=[(1,1,1),(2,0.35,0.6),(3,0.12,0.4),(4.16,0.06,0.25)]
NOTE=[(0.00,880,0.55,0.12),(1.00,880,0.55,0.12),(2.00,880,0.55,0.12),
      (3.00,1046.5,0.50,0.45),(3.08,1318.5,0.50,0.45),(3.16,1568,0.50,0.45),
      (4.10,1046.5,0.50,0.45),(4.18,1318.5,0.50,0.45),(4.26,1568,0.50,0.45)]
DURATA, ATTACCO, PICCO, SR = 5.6, 0.004, 0.95, 44100

def sintetizza(sr=SR):
    N=round(DURATA*sr); buf=[0.0]*N
    for t0,f,amp,tau in NOTE:
        n0=round(t0*sr); ln=min(N-n0, round(tau*8*sr))
        for i in range(ln):
            t=i/sr; env=t/ATTACCO if t<ATTACCO else 1
            v=sum(a*math.exp(-t/(tau*d))*math.sin(2*math.pi*f*r*t) for r,a,d in PARZIALI if f*r<sr/2)
            buf[n0+i]+=amp*env*v
    pk=max(abs(x) for x in buf); k=PICCO/pk if pk else 1
    return [x*k for x in buf]

if __name__=="__main__":
    out=os.path.join(os.path.dirname(os.path.abspath(__file__)),"android","src","main","res","raw","allarme_recupero.wav")
    w=wave.open(out,"wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(b"".join(struct.pack("<h",int(round(x*32767))) for x in sintetizza())); w.close()
    print("scritto",out)

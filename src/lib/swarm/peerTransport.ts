import { addIceCandidate, createAnswer, createOffer, createPeerConnection, handleAnswer } from '../webrtc'

type SignalPayload = { sdp?: string; ice?: string }

export class PeerTransport {
  private readonly pcs = new Map<string, RTCPeerConnection>()
  private readonly channels = new Map<string, RTCDataChannel>()

  getChannel(peerId: string): RTCDataChannel | undefined {
    return this.channels.get(peerId)
  }

  async createOutbound(
    peerId: string,
    label: string,
    onIce: (candidate: string) => void
  ): Promise<SignalPayload> {
    const pc = createPeerConnection()
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onIce(JSON.stringify(ev.candidate))
      }
    }
    const dc = pc.createDataChannel(label, { ordered: true })
    this.pcs.set(peerId, pc)
    this.channels.set(peerId, dc)
    const offer = await createOffer(pc)
    return { sdp: offer }
  }

  async acceptInbound(
    peerId: string,
    offer: string,
    onIce: (candidate: string) => void,
    onChannel: (dc: RTCDataChannel) => void
  ): Promise<SignalPayload> {
    const pc = createPeerConnection()
    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        onIce(JSON.stringify(ev.candidate))
      }
    }
    pc.ondatachannel = (ev) => {
      const dc = ev.channel
      this.channels.set(peerId, dc)
      onChannel(dc)
    }
    this.pcs.set(peerId, pc)
    const answer = await createAnswer(pc, offer)
    return { sdp: answer }
  }

  async applySignal(peerId: string, payload: SignalPayload): Promise<void> {
    const pc = this.pcs.get(peerId)
    if (!pc) return
    if (payload.sdp) {
      await handleAnswer(pc, payload.sdp)
      return
    }
    if (payload.ice) {
      await addIceCandidate(pc, payload.ice)
    }
  }

  closePeer(peerId: string): void {
    this.channels.get(peerId)?.close()
    this.channels.delete(peerId)
    this.pcs.get(peerId)?.close()
    this.pcs.delete(peerId)
  }

  closeAll(): void {
    for (const peerId of Array.from(this.pcs.keys())) {
      this.closePeer(peerId)
    }
  }
}

import { Libp2pRecord } from '@libp2p/record'
import errcode from 'err-code'
import { Message, MESSAGE_TYPE } from '../../message/index.js'
import {
  MAX_RECORD_AGE
} from '../../constants.js'
import { bufferToRecordKey, isPublicKeyKey, fromPublicKeyKey } from '../../utils.js'
import { logger } from '@libp2p/logger'
import type { DHTMessageHandler } from '../index.js'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { PeerRouting } from '../../peer-routing/index.js'
import { Components, Initializable } from '@libp2p/components'

const log = logger('libp2p:kad-dht:rpc:handlers:get-value')

export interface GetValueHandlerInit {
  peerRouting: PeerRouting
}

export class GetValueHandler implements DHTMessageHandler, Initializable {
  private components: Components = new Components()
  private readonly peerRouting: PeerRouting

  constructor (init: GetValueHandlerInit) {
    const { peerRouting } = init

    this.peerRouting = peerRouting
  }

  init (components: Components): void {
    this.components = components
  }

  async handle (peerId: PeerId, msg: Message) {
    const key = msg.key

    log('%p asked for key %b', peerId, key)

    if (key == null || key.length === 0) {
      throw errcode(new Error('Invalid key'), 'ERR_INVALID_KEY')
    }

    const response = new Message(MESSAGE_TYPE.GET_VALUE, key, msg.clusterLevel)

    if (isPublicKeyKey(key)) {
      log('is public key')
      const idFromKey = fromPublicKeyKey(key)
      let pubKey: Uint8Array | undefined

      try {
        const key = await this.components.getPeerStore().keyBook.get(idFromKey)

        if (key == null) {
          throw errcode(new Error('No public key found in key book'), 'ERR_NOT_FOUND')
        }

        pubKey = key
      } catch (err: any) {
        if (err.code !== 'ERR_NOT_FOUND') {
          throw err
        }
      }

      if (pubKey != null) {
        log('returning found public key')
        response.record = new Libp2pRecord(key, pubKey, new Date())
        return response
      }
    }

    const [record, closer] = await Promise.all([
      this._checkLocalDatastore(key),
      this.peerRouting.getCloserPeersOffline(msg.key, peerId)
    ])

    if (record != null) {
      log('had record for %b in local datastore', key)
      response.record = record
    }

    if (closer.length > 0) {
      log('had %s closer peers in routing table', closer.length)
      response.closerPeers = closer
    }

    return response
  }

  /**
   * Try to fetch a given record by from the local datastore.
   * Returns the record iff it is still valid, meaning
   * - it was either authored by this node, or
   * - it was received less than `MAX_RECORD_AGE` ago.
   */
  async _checkLocalDatastore (key: Uint8Array) {
    log('checkLocalDatastore looking for %b', key)
    const dsKey = bufferToRecordKey(key)

    // Fetch value from ds
    let rawRecord
    try {
      rawRecord = await this.components.getDatastore().get(dsKey)
    } catch (err: any) {
      if (err.code === 'ERR_NOT_FOUND') {
        return undefined
      }
      throw err
    }

    // Create record from the returned bytes
    const record = Libp2pRecord.deserialize(rawRecord)

    if (record == null) {
      throw errcode(new Error('Invalid record'), 'ERR_INVALID_RECORD')
    }

    // Check validity: compare time received with max record age
    if (record.timeReceived == null ||
      Date.now() - record.timeReceived.getTime() > MAX_RECORD_AGE) {
      // If record is bad delete it and return
      await this.components.getDatastore().delete(dsKey)
      return undefined
    }

    // Record is valid
    return record
  }
}

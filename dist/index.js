"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisAdapter = exports.createAdapter = void 0;
const uid2 = require("uid2");
const redis_1 = require("redis");
const msgpack = require("notepack.io");
const socket_io_adapter_1 = require("socket.io-adapter-broadcast");
const debug = require("debug")("socket.io-redis-broadcast");
module.exports = exports = createAdapter;
/**
 * Request types, for messages between nodes
 */
var RequestType;
(function (RequestType) {
    RequestType[RequestType["SOCKETS"] = 0] = "SOCKETS";
    RequestType[RequestType["ALL_ROOMS"] = 1] = "ALL_ROOMS";
    RequestType[RequestType["REMOTE_JOIN"] = 2] = "REMOTE_JOIN";
    RequestType[RequestType["REMOTE_LEAVE"] = 3] = "REMOTE_LEAVE";
    RequestType[RequestType["REMOTE_DISCONNECT"] = 4] = "REMOTE_DISCONNECT";
    RequestType[RequestType["REMOTE_FETCH"] = 5] = "REMOTE_FETCH";
})(RequestType || (RequestType = {}));
function createRedisClient(uri, opts) {
    if (uri) {
        // handle uri string
        return redis_1.createClient(uri, opts);
    }
    else {
        return redis_1.createClient(opts);
    }
}
function createAdapter(uri, opts = {}) {
    // handle options only
    if (typeof uri === "object") {
        opts = uri;
        uri = null;
    }
    return function (nsp) {
        return new RedisAdapter(nsp, uri, opts);
    };
}
exports.createAdapter = createAdapter;
class RedisAdapter extends socket_io_adapter_1.Adapter {
    /**
     * Adapter constructor.
     *
     * @param nsp - the namespace
     * @param uri - the url of the Redis server
     * @param opts - the options for both the Redis adapter and the Redis client
     *
     * @public
     */
    constructor(nsp, uri, opts = {}) {
        super(nsp, opts.isRoomBroadcastMsgBatchingAllowedCheckFunc, opts.excludeBatchMap);
        this.requests = new Map();
        this.uid = uid2(6);
        this.pubClient = opts.pubClient || createRedisClient(uri, opts);
        this.subClient = opts.subClient || createRedisClient(uri, opts);
        this.requestsTimeout = opts.requestsTimeout || 5000;
        const prefix = opts.key || "socket.io";
        this.channel = prefix + "#" + nsp.name + "#";
        this.requestChannel = prefix + "-request#" + this.nsp.name + "#";
        this.responseChannel = prefix + "-response#" + this.nsp.name + "#";
        const onError = (err) => {
            if (err) {
                this.emit("error", err);
            }
        };
        this.subClient.psubscribe(this.channel + "*", onError);
        this.subClient.on("pmessageBuffer", this.onmessage.bind(this));
        this.subClient.subscribe([this.requestChannel, this.responseChannel], onError);
        this.subClient.on("messageBuffer", this.onrequest.bind(this));
        this.pubClient.on("error", onError);
        this.subClient.on("error", onError);
    }
    /**
     * Called with a subscription message
     *
     * @private
     */
    onmessage(pattern, channel, msg) {
        channel = channel.toString();
        const channelMatches = channel.startsWith(this.channel);
        if (!channelMatches) {
            return debug("ignore different channel");
        }
        const room = channel.slice(this.channel.length, -1);
        if (room !== "" && !this.rooms.has(room)) {
            return debug("ignore unknown room %s", room);
        }
        const args = msgpack.decode(msg);
        const [uid, packet, opts] = args;

        if (this.uid === uid){
            return debug("ignore same uid");
        }
        if (packet && packet.nsp === undefined) {
            packet.nsp = "/";
        }
        if (!packet || packet.nsp !== this.nsp.name) {
            return debug("ignore different namespace");
        }
        opts.rooms = new Set(opts.rooms);
        opts.except = new Set(opts.except);

        super.broadcast(packet, opts);
    }
    /**
     * Called on request from another node
     *
     * @private
     */
    async onrequest(channel, msg) {
        channel = channel.toString();
        if (channel.startsWith(this.responseChannel)) {
            return this.onresponse(channel, msg);
        }
        else if (!channel.startsWith(this.requestChannel)) {
            return debug("ignore different channel");
        }
        let request;
        try {
            request = JSON.parse(msg);
        }
        catch (err) {
            this.emit("error", err);
            return;
        }
        debug("received request %j", request);
        let response, socket;
        switch (request.type) {
            case RequestType.SOCKETS:
                if (this.requests.has(request.requestId)) {
                    return;
                }
                const sockets = await super.sockets(new Set(request.rooms));
                response = JSON.stringify({
                    requestId: request.requestId,
                    sockets: [...sockets],
                });
                this.pubClient.publish(this.responseChannel, response);
                break;
            case RequestType.ALL_ROOMS:
                if (this.requests.has(request.requestId)) {
                    return;
                }
                response = JSON.stringify({
                    requestId: request.requestId,
                    rooms: [...this.rooms.keys()],
                });
                this.pubClient.publish(this.responseChannel, response);
                break;
            case RequestType.REMOTE_JOIN:
                if (request.opts) {
                    const opts = {
                        rooms: new Set(request.opts.rooms),
                        except: new Set(request.opts.except),
                    };
                    return super.addSockets(opts, request.rooms);
                }
                socket = this.nsp.sockets.get(request.sid);
                if (!socket) {
                    return;
                }
                socket.join(request.room);
                response = JSON.stringify({
                    requestId: request.requestId,
                });
                this.pubClient.publish(this.responseChannel, response);
                break;
            case RequestType.REMOTE_LEAVE:
                if (request.opts) {
                    const opts = {
                        rooms: new Set(request.opts.rooms),
                        except: new Set(request.opts.except),
                    };
                    return super.delSockets(opts, request.rooms);
                }
                socket = this.nsp.sockets.get(request.sid);
                if (!socket) {
                    return;
                }
                socket.leave(request.room);
                response = JSON.stringify({
                    requestId: request.requestId,
                });
                this.pubClient.publish(this.responseChannel, response);
                break;
            case RequestType.REMOTE_DISCONNECT:
                if (request.opts) {
                    const opts = {
                        rooms: new Set(request.opts.rooms),
                        except: new Set(request.opts.except),
                    };
                    return super.disconnectSockets(opts, request.close);
                }
                socket = this.nsp.sockets.get(request.sid);
                if (!socket) {
                    return;
                }
                socket.disconnect(request.close);
                response = JSON.stringify({
                    requestId: request.requestId,
                });
                this.pubClient.publish(this.responseChannel, response);
                break;
            case RequestType.REMOTE_FETCH:
                if (this.requests.has(request.requestId)) {
                    return;
                }
                const opts = {
                    rooms: new Set(request.opts.rooms),
                    except: new Set(request.opts.except),
                };
                const localSockets = await super.fetchSockets(opts);
                response = JSON.stringify({
                    requestId: request.requestId,
                    sockets: localSockets.map((socket) => ({
                        id: socket.id,
                        handshake: socket.handshake,
                        rooms: [...socket.rooms],
                        data: socket.data,
                    })),
                });
                this.pubClient.publish(this.responseChannel, response);
                break;
            default:
                debug("ignoring unknown request type: %s", request.type);
        }
    }
    /**
     * Called on response from another node
     *
     * @private
     */
    onresponse(channel, msg) {
        let response;
        try {
            response = JSON.parse(msg);
        }
        catch (err) {
            this.emit("error", err);
            return;
        }
        const requestId = response.requestId;
        if (!requestId || !this.requests.has(requestId)) {
            debug("ignoring unknown request");
            return;
        }
        debug("received response %j", response);
        const request = this.requests.get(requestId);
        switch (request.type) {
            case RequestType.SOCKETS:
            case RequestType.REMOTE_FETCH:
                request.msgCount++;
                // ignore if response does not contain 'sockets' key
                if (!response.sockets || !Array.isArray(response.sockets))
                    return;
                if (request.type === RequestType.SOCKETS) {
                    response.sockets.forEach((s) => request.sockets.add(s));
                }
                else {
                    response.sockets.forEach((s) => request.sockets.push(s));
                }
                if (request.msgCount === request.numSub) {
                    clearTimeout(request.timeout);
                    if (request.resolve) {
                        request.resolve(request.sockets);
                    }
                    this.requests.delete(requestId);
                }
                break;
            case RequestType.ALL_ROOMS:
                request.msgCount++;
                // ignore if response does not contain 'rooms' key
                if (!response.rooms || !Array.isArray(response.rooms))
                    return;
                response.rooms.forEach((s) => request.rooms.add(s));
                if (request.msgCount === request.numSub) {
                    clearTimeout(request.timeout);
                    if (request.resolve) {
                        request.resolve(request.rooms);
                    }
                    this.requests.delete(requestId);
                }
                break;
            case RequestType.REMOTE_JOIN:
            case RequestType.REMOTE_LEAVE:
            case RequestType.REMOTE_DISCONNECT:
                clearTimeout(request.timeout);
                if (request.resolve) {
                    request.resolve();
                }
                this.requests.delete(requestId);
                break;
            default:
                debug("ignoring unknown request type: %s", request.type);
        }
    }
    /**
     * Broadcasts a packet.
     *
     * @param {Object} packet - packet to emit
     * @param {Object} opts - options
     *
     * @public
     */
    broadcast(packet, opts) {
        packet.nsp = this.nsp.name;
        const onlyLocal = opts && opts.flags && opts.flags.local;
        if (!onlyLocal) {
            const rawOpts = {
                rooms: [...opts.rooms],
                except: [...new Set(opts.except)],
                flags: opts.flags,
            };
            const msg = msgpack.encode([this.uid, packet, rawOpts]);
            let channel = this.channel;
            if (opts.rooms && opts.rooms.size === 1) {
                channel += opts.rooms.keys().next().value + "#";
            }
            debug("publishing message to channel %s", channel);
            this.pubClient.publish(channel, msg);
        }
        super.broadcast(packet, opts);
    }
    /**
     * Gets a list of sockets by sid.
     *
     * @param {Set<Room>} rooms   the explicit set of rooms to check.
     */
    async sockets(rooms) {
        const localSockets = await super.sockets(rooms);
        const numSub = await this.getNumSub();
        debug('waiting for %d responses to "sockets" request', numSub);
        if (numSub <= 1) {
            return Promise.resolve(localSockets);
        }
        const requestId = uid2(6);
        const request = JSON.stringify({
            requestId,
            type: RequestType.SOCKETS,
            rooms: [...rooms],
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for sockets response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.SOCKETS,
                numSub,
                resolve,
                timeout,
                msgCount: 1,
                sockets: localSockets,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * Gets the list of all rooms (across every node)
     *
     * @public
     */
    async allRooms() {
        const localRooms = new Set(this.rooms.keys());
        const numSub = await this.getNumSub();
        debug('waiting for %d responses to "allRooms" request', numSub);
        if (numSub <= 1) {
            return localRooms;
        }
        const requestId = uid2(6);
        const request = JSON.stringify({
            requestId,
            type: RequestType.ALL_ROOMS,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for allRooms response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.ALL_ROOMS,
                numSub,
                resolve,
                timeout,
                msgCount: 1,
                rooms: localRooms,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * Makes the socket with the given id join the room
     *
     * @param {String} id - socket id
     * @param {String} room - room name
     * @public
     */
    remoteJoin(id, room) {
        const requestId = uid2(6);
        const socket = this.nsp.sockets.get(id);
        if (socket) {
            socket.join(room);
            return Promise.resolve();
        }
        const request = JSON.stringify({
            requestId,
            type: RequestType.REMOTE_JOIN,
            sid: id,
            room,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for remoteJoin response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_JOIN,
                resolve,
                timeout,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * Makes the socket with the given id leave the room
     *
     * @param {String} id - socket id
     * @param {String} room - room name
     * @public
     */
    remoteLeave(id, room) {
        const requestId = uid2(6);
        const socket = this.nsp.sockets.get(id);
        if (socket) {
            socket.leave(room);
            return Promise.resolve();
        }
        const request = JSON.stringify({
            requestId,
            type: RequestType.REMOTE_LEAVE,
            sid: id,
            room,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for remoteLeave response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_LEAVE,
                resolve,
                timeout,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * Makes the socket with the given id to be forcefully disconnected
     * @param {String} id - socket id
     * @param {Boolean} close - if `true`, closes the underlying connection
     *
     * @public
     */
    remoteDisconnect(id, close) {
        const requestId = uid2(6);
        const socket = this.nsp.sockets.get(id);
        if (socket) {
            socket.disconnect(close);
            return Promise.resolve();
        }
        const request = JSON.stringify({
            requestId,
            type: RequestType.REMOTE_DISCONNECT,
            sid: id,
            close,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for remoteDisconnect response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_DISCONNECT,
                resolve,
                timeout,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    async fetchSockets(opts) {
        var _a;
        const localSockets = await super.fetchSockets(opts);
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return localSockets;
        }
        const numSub = await this.getNumSub();
        debug('waiting for %d responses to "fetchSockets" request', numSub);
        if (numSub <= 1) {
            return localSockets;
        }
        const requestId = uid2(6);
        const request = JSON.stringify({
            requestId,
            type: RequestType.REMOTE_FETCH,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for fetchSockets response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_FETCH,
                numSub,
                resolve,
                timeout,
                msgCount: 1,
                sockets: localSockets,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    addSockets(opts, rooms) {
        var _a;
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return super.addSockets(opts, rooms);
        }
        const request = JSON.stringify({
            type: RequestType.REMOTE_JOIN,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
            rooms: [...rooms],
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    delSockets(opts, rooms) {
        var _a;
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return super.delSockets(opts, rooms);
        }
        const request = JSON.stringify({
            type: RequestType.REMOTE_LEAVE,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
            rooms: [...rooms],
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    disconnectSockets(opts, close) {
        var _a;
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return super.disconnectSockets(opts, close);
        }
        const request = JSON.stringify({
            type: RequestType.REMOTE_DISCONNECT,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
            close,
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    /**
     * Get the number of subscribers of the request channel
     *
     * @private
     */
    getNumSub() {
        if (this.pubClient.constructor.name === "Cluster") {
            // Cluster
            const nodes = this.pubClient.nodes();
            return Promise.all(nodes.map((node) => node.send_command("pubsub", ["numsub", this.requestChannel]))).then((values) => {
                let numSub = 0;
                values.map((value) => {
                    numSub += parseInt(value[1], 10);
                });
                return numSub;
            });
        }
        else {
            // RedisClient or Redis
            return new Promise((resolve, reject) => {
                this.pubClient.send_command("pubsub", ["numsub", this.requestChannel], (err, numSub) => {
                    if (err)
                        return reject(err);
                    resolve(parseInt(numSub[1], 10));
                });
            });
        }
    }
}
exports.RedisAdapter = RedisAdapter;

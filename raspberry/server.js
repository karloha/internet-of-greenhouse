var serialAPI = require('serialport'),
	SerialPort = serialAPI.SerialPort,
	WebSocket = require('ws'),
	ws = null,
	serialPorts = [],
	serialPort = null,
	updateInterval = null;
	lastTickTime = 0,
	tickInterval = 100,
	lastDt = tickInterval,
	lastIrrigationTime = 0,
	irrigationDuration = 0,
	targetLightIntensity = 0,
	lastPingTime = 0,
	portName = null,
	config = {
		socket: {
			host: '127.0.0.1',
			port: 8080
		},
		lighting: {
			threshold: 50
		},
		irrigation: {
			interval: 2 * 60 * 1000,
			duration: 20 * 1000,
			preOxinateDuration: 5 * 1000
		},
		//acquisitionInterval: 60000
		acquisitionInterval: 1000,
		readingScale: 1023,
		lightFadeDuration: 1000,
		pingInterval: 1000
	},
	State = {
		OFF: 0,
		ON: 1,
		AUTO: 2
	},
	Status = {
		OFF: 0,
		ON: 1
	},
	state = {
		irrigation: State.AUTO,
		lighting: State.AUTO,
		oxygen: State.AUTO
	},
	status = {
		irrigation: Status.OFF,
		lighting: Status.OFF,
		oxygen: Status.OFF,
		lightLevel: 0
	},
	lastState = null,
	lastStatus = null,
	handlers = {
		serial: {
			'light-level': function(request) {
				status.lightLevel = parseInt(request.parameters[0], 10);

				if (status.lightLevel < 0) {
					status.lightLevel = 0;
				} else if (status.lightLevel > config.readingScale) {
					status.lightLevel = config.readingScale;
				}

				sendSocket('light-level:' + status.lightLevel);
			}
		},
		socket: {
			'irrigation': function(request) {
				setState('irrigation', request.parameters[0]);
			},
			'lighting': function(request) {
				setState('lighting', request.parameters[0]);
			},
			'oxygen': function(request) {
				setState('oxygen', request.parameters[0]);
			},

			'get-irrigation': function(request) {
				sendSocket('irrigation:' + state.irrigation);
			},
			'get-lighting': function(request) {
				sendSocket('lighting:' + state.lighting);
			},
			'get-oxygen': function(request) {
				sendSocket('oxygen:' + state.oxygen);
			},
			'get-light-level': function(request) {
				sendSocket('oxygen:' + state.oxygen);
			},

			'get-config': function() {
				lastState = null;
				lastStatus = null;

				sendConfig();
				tick();
			},

			// configuration parameters
			'lighting-threshold': function(request) {
				var value = Math.min(Math.max(parseInt(request.parameters[0], 10), 0), 100);

				config.lighting.threshold = value;

				sendConfig();
			},
			'irrigation-interval': function(request) {
				var value = Math.max(parseInt(request.parameters[0], 10), 0);

				config.irrigation.interval = value;

				sendConfig();
			},
			'irrigation-duration': function(request) {
				var value = Math.max(parseInt(request.parameters[0], 10), 0);

				config.irrigation.duration = value;

				sendConfig();
			}
		}
	};

function setState(name, value) {
	state[name] =  parseInt(value, 10);

	tick();
}

function lerp(a, b, u) {
	return (1 - u) * a + u * b;
}

function sendConfig() {
	sendSocket('config:' + JSON.stringify(config));
}

function log() {
	console.log.apply(console, arguments);
}

function sendSerial(message) {
	log('SERIAL > ' + message);

	serialPort.write(message);
}

function sendSocket(message) {
	if (ws.readyState !== 1) {
		log('! Socket not ready yet to transmit: ' + message);

		return;
	}

	log('SOCKET > ' + message);

	ws.send(message);
}

function setupSerial() {
	serialPort = new SerialPort(portName, {
		baudrate: 9600,
		parser: serialAPI.parsers.readline('\r\n')
	});

	serialPort.on('open',function() {
		log('! Serial connection opened');

		serialPort.on('data', function(data) {
			handleSerialMessage(data);
		});

		onSerialOpen();
	});
}

function setupSocket(host, port) {
	var endpoint = 'ws://' + host + ':' + port + '/';

	log('! Connecting to web-socket server at ' + endpoint);

	ws = new WebSocket(endpoint);

	ws.on('open', function() {
		log('! Socket connection opened');

		onSocketOpen();
	});

	ws.on('message', function(message/*, flags*/) {
		handleSocketMessage(message);
	});

	ws.on('error', function() {
		log('- Opening WebSocket connection failed');
	});
}

function setupTicker() {
	setInterval(function() {
		var currentTime = (new Date().getTime());
			dt = tickInterval;

		if (lastTickTime !== 0) {
			dt = currentTime - lastTickTime;
		}

		lastTickTime = currentTime;

		tick(dt, currentTime);
	}, tickInterval);

	setInterval(function() {
		fastTick(10);
	}, 10);
}

function tick(dt, currentTime) {
	dt = dt || lastDt;
	currentTime = currentTime || (new Date().getTime());

	var name,
		value;

	switch (state.lighting) {
		case State.ON:
			targetLightIntensity = 1.0;
		break;

		case State.OFF:
			targetLightIntensity = 0.0;
		break;

		case State.AUTO:
			targetLightIntensity = status.lightLevel / config.readingScale * 100 <= config.lighting.threshold
				? 1.0
				: 0.0;
		break;
	}

	switch (state.irrigation) {
		case State.ON:
			status.irrigation = Status.ON;
			status.oxygen = Status.ON;
			lastIrrigationTime = currentTime;
		break;

		case State.OFF:
			status.irrigation = Status.OFF;
			status.oxygen = Status.OFF;
		break;

		case State.AUTO:
			if (status.oxygen === Status.OFF) {
				if (
					lastIrrigationTime === 0
					|| currentTime - lastIrrigationTime > config.irrigation.interval - config.irrigation.preOxinateDuration
				) {
					status.irrigation = Status.OFF;
					status.oxygen = Status.ON;
					irrigationDuration = 0;
					lastIrrigationTime = currentTime;
				}
			} else {
				irrigationDuration += dt;

				if (irrigationDuration > config.irrigation.duration + config.irrigation.preOxinateDuration) {
					status.irrigation = Status.OFF;
					status.oxygen = Status.OFF;
				} else {
					if (irrigationDuration < config.irrigation.preOxinateDuration) {
						status.irrigation = Status.OFF;
					} else {
						status.irrigation = Status.ON;
					}
				}
			}
		break;
	}

	//log('current', status.lighting, 'target', targetLightIntensity)

	for (name in state) {
		if (lastState === null || lastState[name] !== state[name]) {
			sendSocket('state.' + name  + ':' + state[name]);
		}
	}

	for (name in status) {
		if (lastStatus === null || lastStatus[name] !== status[name]) {
			value = status[name];

			if (name === 'irrigation' && value !== 0) {
				value = 200;
			} else if (name === 'lighting') {
				value *= 255;
			}

			sendSerial(name  + ':' + value);
			sendSocket('status.' + name  + ':' + status[name]);
		}
	}

	if (currentTime - lastPingTime > config.pingInterval) {
		sendSerial('ping');

		lastPingTime = currentTime;
	}

	lastState = deepClone(state);
	lastStatus = deepClone(status);
	lastDt = dt;
}

function fastTick(dt) {
	var lastLightingIntensity = status.lighting;

	status.lighting = interpolate(status.lighting, targetLightIntensity, config.lightFadeDuration, dt);

	if (status.lighting !== lastLightingIntensity) {
		sendSerial('lighting:' + status.lighting * 255);
	}
}

function interpolate(current, target, timeMS, dt, min, max) {
	min = min || 0;
	max = max || 1;

	return Math.min(Math.max(current + (timeMS / 1000) * (dt / 1000) * (current < target ? 1 : current > target ? -1 : 0), min), max);
}

function deepClone(obj) {
	return JSON.parse(JSON.stringify(obj));
}

function onSerialOpen() {
	sendSerial('reset');

	if (updateInterval !== null) {
		clearInterval(updateInterval);
	}

	updateInterval = setInterval(function() {
		requestUpdate();
	}, config.acquisitionInterval);

	requestUpdate();
}

function onSocketOpen() {
	sendSocket('become-device');
}

function requestUpdate() {
	sendSerial('get-light-level');
}

function handleSerialMessage(message) {
	var request = parseMessage(message);

	log('SERIAL < ' + message);

	if (typeof(handlers.serial[request.name]) === 'function') {
		handlers.serial[request.name].apply(handlers[request.name], [request]);
	}
}

function handleSocketMessage(message) {
	var request = parseMessage(message);

	log('SOCKET < ' + message);

	if (typeof(handlers.socket[request.name]) === 'function') {
		handlers.socket[request.name].apply(handlers[request.name], [request]);
	}
}

function parseMessage(message) {
	var delimiterPos = message.indexOf(':'),
		name = message,
		parameters = [],
		tokens;

	if (delimiterPos !== -1) {
		tokens = message.split(':');
		name = tokens[0];
		parameters = tokens.slice(1);
	}

	return {
		name: name,
		parameters: parameters,
		original: message,
		serial: '<' + message + '>'
	};
}

function bootstrap() {
	if (process.argv.length >= 3) {
		config.socket.host = process.argv[2];
	}

	if (process.argv.length >= 4) {
		config.socket.port = process.argv[3];
	}

	serialAPI.list(function (err, ports) {
		for (var i = 0; i < ports.length; i++) {
			log('! Detected port ' + ports[i].comName + '(' + ports[i].manufacturer + ')');

			serialPorts.push({
				id: ports[i].comName,
				name: ports[i].manufacturer
			});

			if (
				typeof(ports[i].manufacturer) !== 'string'
				|| ports[i].manufacturer.indexOf('PJRC') !== -1
				|| ports[i].manufacturer.toLowerCase().indexOf('arduino') !== -1
			) {
				log('! Found hardware on ' + ports[i].comName);

				portName = ports[i].comName;
			}
		}

		if (portName === null) {
			log('- Failed to find the device on any of the COM ports');

			process.exit(1);
		}

		init(portName);
	});
}

function init(portName) {
	log('! Initiating on ' + portName);

	setupSocket(config.socket.host, config.socket.port);
	setupSerial();
	setupTicker();
}


bootstrap();
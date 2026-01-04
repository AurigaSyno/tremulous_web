var _ = require('underscore');
var async = require('async');
var compression = require('compression');
var crc32 = require('buffer-crc32');
var express = require('express');
var fs = require('fs');
var http = require('http');
var winston = require('winston');
var logger = winston;
var path = require('path');
var send = require('send');
var zlib = require('zlib');

var argv = require('minimist')(process.argv.slice(2), {
	default: {
		config: './config.json'
	}
});

if (argv.h || argv.help) {
	console.log('Usage: node content.js [options]');
	console.log('Options:');
	console.log('  --config <path>  Location of the configuration file (default: ./config.json)');
	console.log('  -h, --help       Show this help message');
	return;
}

// Add console transport by default to prevent "no transports" warning
logger.add(new winston.transports.Console({
	format: winston.format.combine(
		winston.format.colorize(),
		winston.format.simple()
	)
}));

var config = loadConfig(argv.config);
var validAssets = config.validAssets || ['.pk3', '.run', '.sh', '.qvm'];
var currentManifestTimestamp;
var currentManifest;

// Configure logger based on config
logger.level = config.logging && config.logging.logLevel ? config.logging.logLevel : 'info';

// Add file transport if logging is enabled
if (config.logging && config.logging.enabled) {
	var logPath = config.logging.logPath || 'logs';
	var logName = config.logging.logName || 'content-server';
	var maxSize = config.logging.logMaxSizeBytes || 10485760;
	var maxFiles = config.logging.logMaxFiles || 5;

	// Ensure log directory exists
	if (!fs.existsSync(logPath)) {
		fs.mkdirSync(logPath, { recursive: true });
	}

	logger.add(new winston.transports.File({
		filename: path.join(logPath, logName + '.log'),
		maxsize: maxSize,
		maxFiles: maxFiles,
		json: false,
		timestamp: true
	}));
}

function getAssets() {
	var files = [];
	
	function readDirRecursive(dir) {
		var entries = fs.readdirSync(dir, { withFileTypes: true });
		
		for (var i = 0; i < entries.length; i++) {
			var entry = entries[i];
			var fullPath = path.join(dir, entry.name);
			
			if (entry.isDirectory()) {
				readDirRecursive(fullPath);
			} else if (entry.isFile()) {
				var relativePath = path.relative(config.root, fullPath);
				files.push(relativePath);
			}
		}
	}
	
	readDirRecursive(config.root);
	
	return files.filter(function (file) {
		var ext = path.extname(file);
		return validAssets.indexOf(ext) !== -1;
	}).map(function (file) {
		return path.join(config.root, file);
	});
}

function generateManifest(callback) {
	logger.info('generating manifest from ' + config.root);

	var assets = getAssets();
	var start = Date.now();

	async.map(assets, function (file, cb) {
		logger.info('processing ' + file);

		var name = path.relative(config.root, file);
		var crc = crc32.unsigned('');
		var compressed = 0;
		var size = 0;

		// stream each file in, generating a hash for it's original
		// contents, and gzip'ing buffer to determine the compressed
		// length for client so it can present accurate progress info
		var stream = fs.createReadStream(file);

		// gzip file contents to determine the compressed length
		// of file so that client can present correct progress info
		var gzip = zlib.createGzip();

		stream.on('error', function (err) {
			callback(err);
		});
		stream.on('data', function (data) {
			crc = crc32.unsigned(data, crc);
			size += data.length;
			gzip.write(data);
		});
		stream.on('end', function () {
			gzip.end();
		});

		gzip.on('data', function (data) {
			compressed += data.length;
		});
		gzip.on('end', function () {
			cb(null, {
				name: name,
				compressed: compressed,
				checksum: crc
			});
		});
	}, function (err, entries) {
		if (err) return callback(err);
		logger.info('generated manifest (' + entries.length + ' entries) in ' + ((Date.now() - start) / 1000) + ' seconds');

		callback(err, entries);
	});
}

function handleManifest(req, res, next) {
	logger.info('serving manifest to ' + req.ip);

	res.setHeader('Cache-Control', 'public, max-age=60, must-revalidate');
	res.setHeader('Last-Modified', currentManifestTimestamp.toUTCString());

	res.json(currentManifest);
}

function handleAsset(req, res, next) {
	logger.info('serving asset to ' + req.ip);
	var basedir = req.params[0];
	var checksum = parseInt(req.params[1], 10);
	var basename = req.params[2];
	var relativePath = path.join(basedir, basename);
	var absolutePath = path.resolve(config.root, relativePath);

	// make sure they're requesting a valid asset
	var asset;
	for (var i = 0; i < currentManifest.length; i++) {
		var entry = currentManifest[i];

		if (entry.name === relativePath && entry.checksum === checksum) {
			asset = entry;
			break;
		}
	}

	if (!asset) {
		res.status(400).end();
		return;
	}

	logger.info('serving ' + relativePath + ' (crc32 ' + checksum + ') to ' + req.ip);

	res.sendFile(absolutePath, { maxAge: Infinity });
}

function loadConfig(configPath) {
	var config = {
		root: 'pk3_assets',
		port: 9000,
		validAssets: ['.pk3', '.run', '.sh', '.qvm']
	};

	try {
		logger.info('loading config file from ' + configPath + '..');
		var data = require(configPath);
		_.extend(config, data);
	} catch (e) {
		logger.warn('failed to load config', e);
	}

	return config;
}

(function main() {
	var app = express();
	app.use(function (req, res, next) {
		res.setHeader('Access-Control-Allow-Origin', '*');
		next();
	});
	app.use(compression({ filter: function(req, res) { return true; } }));
	app.get('/assets/manifest.json', handleManifest);
	app.get(/^\/assets\/(.+\/|)(\d+)-(.+?)$/, handleAsset);

	// generate an initial manifest
	generateManifest(function (err, manifest) {
		if (err) throw err;

		currentManifestTimestamp = new Date();
		currentManifest = manifest;

		// start listening
		var server = http.createServer(app);

		// listen only on 0.0.0.0 to force ipv4
		server.listen(config.port, '0.0.0.0', function () {
			logger.info('content server is now listening on port ' + server.address().port);
		});
		server.keepAliveTimeout = 60 * 1000;
	});
})();

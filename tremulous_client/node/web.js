var _ = require('underscore');
var express = require('express');
var http = require('http');
var winston = require('winston');
var path = require('path');

var argv = require('minimist')(process.argv.slice(2), {
	default: {
		config: './config.json'
	}
});

if (argv.h || argv.help) {
	console.log('Usage: node web.js [options]');
	console.log('Options:');
	console.log('  --config <path>  Location of the configuration file (default: ./config.json)');
	console.log('  -h, --help       Show this help message');
	return;
}

winston.add(new winston.transports.Console({
	format: winston.format.combine(
		winston.format.colorize(),
		winston.format.simple()
	)
}));
winston.level = 'debug';

var config = loadConfig(argv.config);

function loadConfig(configPath) {
	var config = {
		port: 8080,
		content: '127.0.0.1:9000'
	};

	try {
		winston.info('loading config file from ' + configPath + '..');
		var data = require(configPath);
		_.extend(config, data);
	} catch (e) {
		winston.warn('failed to load config', e);
	}

	return config;
}

(function main() {
	var app = express();

	app.set('views', __dirname);
	app.set('view engine', 'ejs');

	app.use(express.static('bin'));
	app.use(function (req, res, next) {
		// Pass content, client config, and player names to the template
			res.locals.content = config.content;
			res.locals.client = config.client || {};
			res.locals.player_names = config.client && config.client.player_names ? config.client.player_names : [];
		next();
	});
	app.get('/', function (req, res) {
		res.render('index');
	});

	var server = http.createServer(app);
	server.listen(config.port, function () {
		winston.info('web server is now listening on port '+ server.address().port);
	});

	return server;
})();

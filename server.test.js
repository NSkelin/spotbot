const Server = require('./server.js');
const startCommands = require('./startCommands.json');

test('test test', () => {
	var server = new Server(startCommands[1], startCommands[1]);
})
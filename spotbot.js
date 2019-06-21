var Discord = require('discord.io');
var logger = require('winston');
var auth = require('./auth.json');
// Configure logger settings
logger.remove(logger.transports.Console);
logger.add(new logger.transports.Console, {
    colorize: true
});
logger.level = 'debug';
// Initialize Discord Bot
var bot = new Discord.Client({
   token: auth.token,
   autorun: true
});
bot.on('ready', function (evt) {
    logger.info('Connected');
    logger.info('Logged in as: ');
    logger.info(bot.username + ' - (' + bot.id + ')');
});

// amazon aws cli setup
var awsCli = require('aws-cli-js');
var Options = awsCli.Options;
var Aws = awsCli.Aws;
var options = new Options(
  /* accessKey    */ 'AKIAVW3BLGQL3SVGICX7',
  /* secretKey    */ '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',
  /* sessionToken */ null,
  /* currentWorkingDirectory */ null
);
var aws = new Aws(options);
const  s3BucketName = "mc-server-a00912617";
const startInstanceFunctionActive = false;
function sleep (ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// user serverName var
function getIp (serverName, callback) {
	aws.command(
	'ec2 describe-instances --filter "Name=tag:Name,Values=mcm_server" --query "Reservations[0].Instances[0].PublicIpAddress"')
	.then(function (data) {
		callback(data.object);
	});
}

function getInstanceId (serverName) {
	return new Promise((resolve, reject) => {
		aws.command('ec2 describe-instances --filter "Name=tag:Name,Values=' + serverName +'" --query "Reservations[0].Instances[0].InstanceId"')
		.then(async (instanceId) => {
			if (instanceId.object === null) {
				reject(instanceId);
			} else {
				resolve(instanceId.object);
			}
		});
	})
}

// starts a spot instance and tags it
function startInstance (serverName) {
	// ##### Start Spot Instance #####
	// figure out queues or someway to only allow one person to run this function at a time
	if (startInstanceFunctionActive) {
		reject('Server is already being started');
		return
	} else {
		startInstanceFunctionActive = true;
		return new Promise((resolve, reject) => {
			aws.command('ec2 describe-instances --filter "Name=tag:Name,Values=' + serverName + '" --query Reservations[0]')
			.then(async (serverStatus) => {
				// checks if the server is still running and if it is exit
				// if its not but it still has the tag name remove the tag
				if (serverStatus.object != null) {
					var state = serverStatus.object.Instances[0].State.Name
					if (state === "shutting-down" || state === "terminated") {
						getInstanceId(serverName)
						.then((instanceId) => {
							aws.command('ec2 delete-tags --resources ' + instanceId + ' --tags Key=Name,Value=' + serverName)
						});
					} else {
						reject(serverStatus);
						startInstanceFunctionActive = false;
						return
					}
				}
				// create spot instance and tag it
				aws.command('ec2 request-spot-instances --availability-zone-group us-west-2 --instance-count 1 --launch-specification file://specification.json');
				await sleep(3500); // wait for amazon
				aws.command('ec2 describe-instances --filter "Name=instance-state-name,Values=pending" --query "Reservations[0].Instances[0].InstanceId"')
				.then((instanceId) => {
					aws.command('ec2 create-tags --resource ' + instanceId.object + ' --tags Key=Name,Value=' + serverName)
					startInstanceFunctionActive = false;
					resolve();
				});
			});
		});
	}
}
// creates a cloud watch alarm that terminates the instance if networkOut is below threshold (aka no players connected)
function createShutdownAlarm (instanceId) {
	aws.command('cloudwatch put-metric-alarm \
	--alarm-name "alarm when MCM server doesnt have anyone online for a time" \
	--alarm-description "Automatically shutoff the server if no one is connected" \
	--metric-name "NetworkOut" \
	--alarm-actions "arn:aws:automate:us-west-2:ec2:terminate" \
	--dimensions "Name=InstanceId,Value='+instanceId+'" \
	--evaluation-periods "8" \
	--datapoints-to-alarm "7" \
	--threshold "500000" \
	--comparison-operator "LessThanOrEqualToThreshold" \
	--period "300" \
	--namespace "AWS/EC2" \
	--statistic "Average"')
}

// creates amazon rules / events to handle backipng up the game server files
function createBackupEvents (instanceId) {
	// backup periodically (30min)
	aws.command("events put-rule \
		--name 'mcm_periodic_backup' \
		--schedule-expression 'rate(30 minutes)' \
		--state 'ENABLED' \
		--description 'creates a backup periodically'")
	.then(() => {
		aws.command('events put-targets '+
		'--rule "mcm_periodic_backup" '+
		'--targets '+
		'"Id"="1",'+
		'"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",'+
		'"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[' + instanceId + ']}}",'+
		'"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",'+
		'"Input"=\'\"{\\\"commands\\\": [\\\"aws s3 cp ./minecraft_server s3://' + s3BucketName + '/mcm_server --recursive\\\"],'+
		'\\\"workingDirectory\\\": [\\\"/home/ec2-user\\\"],'+
		'\\\"executionTimeout\\\": [\\\"3600\\\"]}\"\'');
	});

	// backup on ec2 spot termination
	aws.command('events put-rule --name "mcm_interrupt_backup" --event-pattern \'{\"source\":[\"aws.ec2\"],\"detail-type\":[\"EC2 Spot Instance Interruption Warning\"]}\' --state "ENABLED" --description "creates a backup when the instance terminates"')
	.then(() => {
		aws.command('events put-targets '+
		'--rule "mcm_interrupt_backup" '+
		'--targets '+
		'"Id"="1",'+
		'"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",'+
		'"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[' + instanceId + ']}}",'+
		'"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",'+
		'"Input"=\'\"{\\\"commands\\\": [\\\"aws s3 cp ./minecraft_server s3://' + s3BucketName + '/mcm_server --recursive\\\"],'+
		'\\\"workingDirectory\\\": [\\\"/home/ec2-user\\\"],'+
		'\\\"executionTimeout\\\": [\\\"3600\\\"]}\"\'');
	});
}	

// loads the games files onto the instance and then runs them.
function startGameServer (instanceId) {
	return new Promise(async function(resolve) {
		while (true) {
			var check1;
			var check2;
			aws.command('ec2 describe-instance-status --instance-ids ${ID} --query "InstanceStatuses[0].InstanceStatus.Status"')
			.then((data) => {
				check1 = data.object
			})
			aws.command('ec2 describe-instance-status --instance-ids ${ID} --query "InstanceStatuses[0].SystemStatus.Status"')
			.then((data) => {
				check2 = data.object
			})
			if (check1 == "ok" && check2 == "ok") {
				console.log("Server initialized, Installing minecraft server.");
				aws.command('ssm send-command --document-name "AWS-RunShellScript" '+
					'--comment "Copy data to S3 as backup / save" '+
					'--instance-ids ' + instanceId +
					' --parameters file://mcm_commands.json '+
					'--timeout-seconds 600 '+
					'--region us-west-2')
					break;
			} else {
				console.log("Initializing... Please wait.");
				await sleep(10000);
			}
		}
		resolve();
	});
}

bot.on('message', function (user, userID, channelID, message, evt) {
    // Our bot needs to know if it will execute a command
    // It will listen for messages that will start with `!`
    if (message.substring(0, 1) == '!') {
        var args = message.substring(1).split(' ');
        var cmd = args[0];
       
        args = args.splice(1);
        switch(cmd) {
        	case 'help':
        		bot.sendMessage({
                    to: channelID,
                    message: 'Hi, Heres the current list of commands:\n!start\n!ip\nAlso their are 3 easter egg commands. Can you find them all?'
                });
        	break;
            case 'ip':
            	getIp('mcm_server', function(ip) {
            		if (ip === null) {
            			bot.sendMessage({
		                    to: channelID,
		                    message: 'Server isnt up, try !start'
		            	});
            		} else {
	            		bot.sendMessage({
		                    to: channelID,
		                    message: 'You ask and you shall receive!\n' + ip
		            	});
            		}
            	});
            break;
            case 'start':
        		bot.sendMessage({
        			to: channelID,
        			message: 'Acknowledged Captain! Were getting ready...'
        		});
            	startInstance('mcm_server')
            	.then(async (resolved) => {
            		bot.sendMessage({
            			to: channelID,
            			message: 'Computer powering on!...'
            		});
            		await sleep(3000); // wait for aws to add the tag name to get an instance id
            		getInstanceId('mcm_server')
            		.then((instanceId) => {
            			createShutdownAlarm(instanceId);
            			createBackupEvents(instanceId);

						startGameServer(instanceId)
						.then((resolved) => {
							bot.sendMessage({
		            			to: channelID,
		            			message: 'Starting the game server now! You should be able to join in a few minutes, have fun!'
            				});
            				bot.sendMessage({
		            			to: channelID,
		            			message: '!ip'
            				});
            			});
            		}).catch((error) => {
            			console.log(error);
            			bot.sendMessage({
	            			to: channelID,
	            			message: 'Call the Admin we failed to get an instance ID!'
            			});
            		});
            	}).catch((error) => {
            		console.log(error);
            		bot.sendMessage({
            			to: channelID,
            			message: "Server is already running, try \"!ip\" instead"
            		});
            	});
            break;
            case 'status':
            
            break;
            // easter eggs
            case 'ping':
                bot.sendMessage({
                    to: channelID,
                    message: 'Pong!'
                });
            break;
            case 'alex':
            	bot.sendMessage({
                    to: channelID,
                    message: 'Stole your RAM!'
                });
            break;
            case 'brownies':
            	bot.sendMessage({
                    to: channelID,
                    message: 'Eunk bwonoes'
                });
            break;
     		default:
     			bot.sendMessage({
                    to: channelID,
                    message: 'Unknown command! try "!help" for a list of commands.'
                });
            // make half a heart and bot replys with other half
         }
     }
});
####### This script creates an aws spot instance that hosts a minecraft server. - Nick Skelin
##### Global varibles #####
declare server_name=$"mcm_server"
declare s3bucket_name=$"mc-server-a00912617"
##### Start Spot Instance #####
# check if the server already exists and exit program if true.
declare server_up=$(aws ec2 describe-instances --filter "Name=tag:Name,Values=${server_name}" --query Reservations[0])
if [ "${server_up}" != "null" ]
then
	echo "Server already running."
	echo "Exiting..."
	exit 1
fi
# create spot instance and tag it
aws ec2 request-spot-instances --availability-zone-group us-west-2 --instance-count 1 --launch-specification file://specification.json
sleep 2
declare ID=$(aws ec2 describe-instances --filter "Name=instance-state-name,Values=pending" --query "Reservations[0].Instances[0].InstanceId" --output text)
sleep 1
aws ec2 create-tags --resource ${ID} --tags Key=Name,Value=${server_name}
##### Auto shutdown #####
# create cloud watch alarm that terminates the instace if network out is below threshold (aka no players connected)
aws cloudwatch put-metric-alarm \
--alarm-name "alarm when MCM server doesnt have anyone online for a time" \
--alarm-description "Automatically shutoff the server if no one is connected" \
--metric-name "NetworkOut" \
--alarm-actions "arn:aws:automate:us-west-2:ec2:terminate" \
--dimensions "Name=InstanceId,Value=${ID}" \
--evaluation-periods "8" \
--datapoints-to-alarm "7" \
--threshold "500000" \
--comparison-operator "LessThanOrEqualToThreshold" \
--period "300" \
--namespace "AWS/EC2" \
--statistic "Average"
##### Backups #####
# backup periodically (30min)
aws events put-rule \
--name "mcm_periodic_backup" \
--schedule-expression "rate(30 minutes)" \
--state "ENABLED" \
--description "creates a backup periodically"
aws events put-targets \
--rule "mcm_periodic_backup" \
--targets \
"Id"="1",\
"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",\
"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[${ID}]}}",\
"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",\
"Input"="'
{
	\"commands\": [
		\"aws s3 cp ./minecraft_server s3://${s3bucket_name}/mcm_server --recursive\"
	],
	\"workingDirectory\": [
		\"/home/ec2-user\"
	],
	\"executionTimeout\": [
		\"3600\"
	]
}'"
# backup on ec2 spot termination
aws events put-rule \
--name "mcm_interrupt_backup" \
--event-pattern "{\"source\":[\"aws.ec2\"],\"detail-type\":[\"EC2 Spot Instance Interruption Warning\"]}" \
--state "ENABLED" \
--description "creates a backup when the instance terminates"
aws events put-targets \
--rule "mcm_interrupt_backup" \
--targets \
"Id"="1",\
"Arn"="arn:aws:ssm:us-west-2::document/AWS-RunShellScript",\
"RunCommandParameters"="{RunCommandTargets={Key=InstanceIds,Values=[${ID}]}}",\
"RoleArn"="arn:aws:iam::392656794647:role/Cloudwatch_run_commands",\
"Input"="'
{
	\"commands\": [
		\"aws s3 cp ./minecraft_server s3://${s3bucket_name}/mcm_server --recursive\"
	],
	\"workingDirectory\": [
		\"/home/ec2-user\"
	],
	\"executionTimeout\": [
		\"3600\"
	]
}'"
##### Start Game Server #####
# load and start server files
while :
do
	declare check1=$(aws ec2 describe-instance-status --instance-ids ${ID} --query "InstanceStatuses[0].InstanceStatus.Status" --output text)
	declare check2=$(aws ec2 describe-instance-status --instance-ids ${ID} --query "InstanceStatuses[0].SystemStatus.Status" --output text)
	if [ $check1 == "ok" ] && [ $check2 == "ok" ]
	then
		echo "Server initialized, Installing minecraft server."
		aws ssm send-command --document-name "AWS-RunShellScript"\
		 --comment "Copy data to S3 as backup / save"\
		 --instance-ids ${ID}\
		 --parameters file://mcm_commands.json\
		 --timeout-seconds 600\
		 --region us-west-2
		break
	fi
	echo "Initializing... Please wait."
	sleep 10
done
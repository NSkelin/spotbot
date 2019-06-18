####### Terminates the spot instance and remove all files related to it.
##### Global Variable #####
declare server_name=$"mcm_server"
declare s3bucket_name=$"mc-server-a00912617"
declare ID=$(aws ec2 describe-instances --filter "Name=tag:Name,Values=${server_name}" --query "Reservations[0].Instances[0].InstanceId" --output text)
# backup server files before termination
aws ssm send-command --document-name "AWS-RunShellScript" \
--comment "Copy data to S3 as backup / save" \
--instance-ids "${ID}" \
--parameters '{"commands":["aws s3 cp ./minecraft_server s3://${s3bucket_name}/${server_name} --recursive"],"executionTimeout":["3600"],"workingDirectory":["/home/ec2-user"]}' \
--timeout-seconds 600 \
--region us-west-2
# remove targets and delete rules
aws events remove-targets --rule "mcm_periodic_backup" --ids "1"
aws events remove-targets --rule "mcm_interrupt_backup" --ids "1"
aws events delete-rule --name "mcm_periodic_backup"
aws events delete-rule --name "mcm_interrupt_backup"
# delete alarm
aws cloudwatch delete-alarms --alarm-names "alarm when MCM server doesnt have anyone online for a time"
# remove instance tag name
aws ec2 delete-tags --resources ${ID} --tags Key=Name,Value=${server_name}
# terminate instance
aws ec2 terminate-instances --instance-ids ${ID}